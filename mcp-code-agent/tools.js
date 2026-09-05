import { ObjectId } from 'mongodb';
import { getDb } from './db.js';
import { preflight, startJob, getJob, listJobs, activeJobId, MODEL } from './runner.js';
import { git } from './git.js';
import { NO_CHANGE_NOTE } from './prompt.js';

const DAILY_LIMIT = parseInt(process.env.CODE_AGENT_DAILY_LIMIT ?? '5', 10);

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] });

async function checkLimit(userId) {
  if (!userId || DAILY_LIMIT <= 0) return { allowed: true };
  const db = await getDb();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const count = await db
    .collection('mcp_code_agent_jobs')
    .countDocuments({ userId, createdAt: { $gte: startOfDay } });
  return count >= DAILY_LIMIT
    ? { allowed: false, reason: `Daily limit of ${DAILY_LIMIT} fixes reached.` }
    : { allowed: true };
}

export async function handleRequestFix({ premise }, context) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return fail('ANTHROPIC_API_KEY is not set on the code-agent server.');
    }
    if (!premise || premise.trim().length < 8) {
      return fail('Say what you noticed — a sentence is enough.');
    }

    const store = context.getStore();
    const { userId, conversationId, sender } = store || {};

    const limit = await checkLimit(userId);
    if (!limit.allowed) return fail(limit.reason);

    const pre = await preflight();
    if (!pre.ok) return fail(`Cannot start a fix right now.\n\n${pre.reason}`);

    const jobId = await startJob({ premise: premise.trim(), userId, conversationId, sender });

    return text(
      [
        `Filed. Job \`${jobId}\` is running on ${MODEL}.`,
        '',
        'What happens now: the agent reads the repository, works out what is actually wrong,',
        'fixes it, runs the tests, commits, and deploys. That takes minutes, not seconds.',
        '',
        '**The deploy restarts the api — this conversation will drop when it does.** That is',
        'expected and nothing is lost. Tell the user to hard-refresh the page once, then',
        `call \`check_fix("${jobId}")\` to read what the agent found and did.`,
        '',
        'Do not file this again while it runs.',
      ].join('\n'),
    );
  } catch (err) {
    console.error('request_fix failed:', err);
    return fail(`Could not start a fix: ${err.message}`);
  }
}

export async function handleCheckFix({ job_id, include_diff }, context) {
  try {
    const job = await getJob(job_id);
    if (!job) return fail(`No job \`${job_id}\`. Use list_fixes to find the right id.`);

    const lines = [];
    const commits = job.commits || [];

    switch (job.status) {
      case 'running':
        lines.push(
          `Job \`${job_id}\` is still working (started ${job.createdAt.toISOString().slice(11, 16)} UTC).`,
          'Nothing has been deployed yet. Check again in a few minutes.',
        );
        break;
      case 'deploying':
        lines.push(
          `Job \`${job_id}\` has committed its work and is deploying now.`,
          'The api is restarting; if this call succeeded, it is already back.',
        );
        break;
      case 'no_change':
        lines.push(`Job \`${job_id}\`: no change made.`, '', NO_CHANGE_NOTE);
        break;
      case 'done':
        lines.push(`Job \`${job_id}\`: **done and deployed.**`, '', 'The fix is live. If the user');
        lines.push('has not reloaded since, one hard refresh will pick it up.');
        break;
      case 'rolled_back':
        lines.push(
          `Job \`${job_id}\`: **the change was made, failed to deploy, and was automatically reverted.**`,
          'The stack is back where it started. Relay this as a real failure — do not retry',
          'the same premise without new information.',
        );
        break;
      case 'broken':
        lines.push(
          `Job \`${job_id}\`: **the deploy failed AND the rollback failed. The stack needs a human.**`,
          'Tell the user this plainly and immediately.',
        );
        break;
      default:
        lines.push(`Job \`${job_id}\`: ${job.status}.`);
    }

    lines.push('', '**The premise you filed:**', `> ${job.premise.split('\n').join('\n> ')}`);

    if (job.summary) {
      lines.push('', "**The agent's own report:**", '', job.summary.trim());
    }
    if (commits.length) {
      lines.push('', '**Commits:**', ...commits.map((c) => `- \`${c.short}\` ${c.subject}`));
    }
    if (job.diffstat) {
      lines.push('', '```', job.diffstat, '```');
    }
    // Summary by default, detail on request — the same shape as agent-test.sh,
    // and for the same reason: a full diff is thousands of tokens and is only
    // wanted when the summary has raised a question.
    if (include_diff && job.baseSha && commits.length) {
      const { stdout } = await git(['diff', `${job.baseSha}..${commits[0].hash}`]);
      const body = stdout.length > 60000 ? `${stdout.slice(0, 60000)}\n[…diff truncated]` : stdout;
      lines.push('', '**Full diff:**', '', '```diff', body.trim(), '```');
    } else if (job.diffstat) {
      lines.push('', '_Call check_fix again with include_diff: true to read the whole change._');
    }
    if (job.deploy) {
      lines.push('', `**Deploy:** ${job.deploy}`);
    }
    if (job.revert) {
      lines.push(
        '',
        `**To undo this**, the user runs: \`${job.revert}\``,
        'Offer that if they are unhappy with the result. It is a normal thing to do, not an',
        'emergency measure.',
      );
    }
    if (job.cost != null) {
      lines.push('', `_${job.elapsed ?? '?'}s · $${Number(job.cost).toFixed(4)} · not visible in /cost_`);
    }

    return text(lines.join('\n'));
  } catch (err) {
    console.error('check_fix failed:', err);
    return fail(`Could not read that job: ${err.message}`);
  }
}

export async function handleListFixes({ limit }, context) {
  try {
    const userId = context.getStore()?.userId;
    const jobs = await listJobs(userId, limit);
    if (!jobs.length) return text('No fixes have been filed from this account yet.');

    const running = activeJobId();
    const rows = jobs.map((j) => {
      const when = j.createdAt.toISOString().slice(0, 16).replace('T', ' ');
      const first = j.premise.split('\n')[0];
      const head = first.length > 90 ? `${first.slice(0, 90)}…` : first;
      return `- \`${j._id}\` ${when} — **${j.status}** — ${head}`;
    });

    return text(
      [
        `${jobs.length} most recent:`,
        '',
        ...rows,
        '',
        running ? `Job \`${running}\` is running right now.` : 'Nothing is running.',
        'Call `check_fix(job_id)` for the full report on any of these.',
      ].join('\n'),
    );
  } catch (err) {
    console.error('list_fixes failed:', err);
    return fail(`Could not list fixes: ${err.message}`);
  }
}
