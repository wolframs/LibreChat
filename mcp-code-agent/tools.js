import { ObjectId } from 'mongodb';
import { getDb } from './db.js';
import { preflight, startJob, getJob, listJobs, activeJobId, appendNote, resumeJob, MODEL } from './runner.js';
import { git } from './git.js';
import { NO_CHANGE_NOTE } from './prompt.js';
import { describeTokens } from './tokens.js';

const DAILY_LIMIT = parseInt(process.env.CODE_AGENT_DAILY_LIMIT ?? '3', 10);

const text = (t) => ({ content: [{ type: 'text', text: t }] });

function elapsedOf(job) {
  const secs = Math.round((Date.now() - new Date(job.createdAt).getTime()) / 1000);
  return secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

/**
 * What the session is doing right now, not merely that it is alive.
 *
 * The first version of this could say "still working" and nothing else, because
 * the agent's output only arrived when the process exited. A model watching its
 * own repair had no more insight into it than `ps` would give. The runner now
 * parses the session's event stream as it happens, so this can report the turn
 * count, the tool in flight and the files touched so far — and, when it has been
 * quiet for a while, say so plainly rather than implying healthy progress.
 */
function liveProgress(job) {
  const p = job.progress;
  if (!p) return ['No progress reported yet — the session is still starting up.'];

  const out = [
    `**Turn ${p.turns}${p.maxTurns ? ` of ~${p.maxTurns}` : ''}` +
      `${p.tools ? `, ${p.tools} tool calls` : ''}**` +
      (p.model ? ` · ${p.model}` : ''),
  ];
  if (p.tokens) out.push(`- ${describeTokens(p.tokens)} so far`);
  if (p.lastTool) out.push(`- now: \`${p.lastTool}\``);
  if (p.files?.length) {
    out.push(`- files touched so far: ${p.files.map((f) => `\`${f}\``).join(', ')}`);
  }
  if (p.lastText) out.push('', '> ' + p.lastText.split('\n').join('\n> '));

  const quiet = Math.round((Date.now() - new Date(p.at).getTime()) / 1000);
  if (quiet > 120) {
    out.push(
      '',
      `_No activity for ${Math.round(quiet / 60)} minutes. It may be on a long tool call, ` +
        'or it may be stuck; the job times out on its own._',
    );
  }
  return out;
}
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
    if (!premise || premise.trim().length < 8) {
      return fail('Say what you noticed — a sentence is enough.');
    }

    const { userId } = context.getStore() || {};

    const limit = await checkLimit(userId);
    if (!limit.allowed) return fail(limit.reason);

    const pre = await preflight();
    if (!pre.ok) return fail(`Cannot start a fix right now.\n\n${pre.reason}`);

    const jobId = await startJob({ premise: premise.trim(), userId });

    return text(
      [
        `Filed. Job \`${jobId}\` is running${MODEL ? ` on ${MODEL}` : ''}.`,
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
          `Job \`${job_id}\` is still working — ${elapsedOf(job)} in.`,
          'Nothing has been deployed yet.',
          '',
          ...liveProgress(job),
        );
        break;
      case 'testing':
        lines.push(
          `Job \`${job_id}\` has finished editing and the wrapper is re-running the tests`,
          'before it will deploy anything.',
          '',
          ...liveProgress(job),
        );
        break;
      case 'deploying':
        lines.push(
          `Job \`${job_id}\` has committed its work and is deploying now.`,
          'The api is restarting; if this call succeeded, it is already back.',
          '',
          ...(job.tests ? [`Tests: ${job.tests}`] : []),
        );
        break;
      case 'tests_failed':
        lines.push(
          `Job \`${job_id}\`: **the wrapper re-ran the tests before deploying and they failed.**`,
          'Nothing was deployed and the commits were reverted. The stack is untouched.',
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
    if (job.notes?.length) {
      lines.push('', '**Notes added after filing:**');
      for (const n of job.notes) {
        lines.push(`- _${n.from ?? 'someone'}:_ ${n.text.split('\n').join(' ')}`);
      }
    }
    if (job.stoppedBecause && job.stoppedBecause !== 'success') {
      lines.push('', `_Stopped because: \`${job.stoppedBecause}\`._`);
      if (job.progress?.sessionId && job.status === 'error') {
        lines.push(
          `Its session is intact, so \`resume_fix("${job_id}")\` picks it up where it stopped ` +
            'rather than paying for the same investigation twice.',
        );
      }
    }
    if (job.resumeCount) {
      lines.push('', `_Resumed ${job.resumeCount}×._`);
    }

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
    // Tokens, not dollars. This runs on the operator's Claude Code subscription,
    // so `total_cost_usd` is what the work would have cost at API list price —
    // useful as a sense of scale, misleading as a headline.
    if (job.usageLine) {
      lines.push('', `_${job.elapsed ?? '?'}s · ${job.usageLine}_`);
    }

    return text(lines.join('\n'));
  } catch (err) {
    console.error('check_fix failed:', err);
    return fail(`Could not read that job: ${err.message}`);
  }
}

/**
 * Correct a filing that is already running.
 *
 * A headless session has no input channel once started, so the note goes to a
 * file the briefing tells the agent to re-read before it commits. That makes the
 * correction land if the agent has not finished yet, and land in the record
 * either way — which matters, because the premise is stored verbatim and a
 * premise that was wrong should not sit there uncontested.
 */
export async function handleAddNote({ job_id, note }, context) {
  try {
    const job = await getJob(job_id);
    if (!job) return fail(`No job \`${job_id}\`.`);
    if (!note || note.trim().length < 4) return fail('Say what you want to add.');

    const path = await appendNote(job_id, note, job.sender || 'the filing model');
    const live = ['running', 'testing'].includes(job.status);

    return text(
      live
        ? `Noted on job \`${job_id}\`. The agent is still working and is told to re-read ` +
            `its notes before committing, so this should reach it — but it may already be ` +
            `past that point, so treat it as likely rather than certain.\n\n${path}`
        : `Noted on job \`${job_id}\`, but it is already **${job.status}** — the agent will ` +
            'not see this. It is recorded against the job and in the changelog, so the ' +
            'correction is on the record even though it did not change the outcome.',
    );
  } catch (err) {
    console.error('add_note failed:', err);
    return fail(`Could not add that note: ${err.message}`);
  }
}

/**
 * Pick a cut-off job back up in its own session.
 *
 * The turn limit ends a run without ending the session: the transcript is intact
 * on disk with every file read and every conclusion reached. Filing again would
 * pay for that investigation a second time and arrive in the same place.
 */
export async function handleResumeFix({ job_id }, context) {
  try {
    const job = await getJob(job_id);
    if (!job) return fail(`No job \`${job_id}\`. Use list_fixes to find the right id.`);

    const outcome = await resumeJob(job_id);
    if (!outcome.ok) return fail(`Cannot resume that job.\n\n${outcome.reason}`);

    return text(
      [
        `Resuming job \`${job_id}\` in its original session.`,
        '',
        'It keeps everything it had already read and worked out, so it is picking up',
        'rather than starting over. Notes added since it was cut off are the first thing',
        'it is told to re-read.',
        '',
        '**The deploy will restart the api and drop this conversation again.** Hard-refresh,',
        `then \`check_fix("${job_id}")\`.`,
      ].join('\n'),
    );
  } catch (err) {
    console.error('resume_fix failed:', err);
    return fail(`Could not resume: ${err.message}`);
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
