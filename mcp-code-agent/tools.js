import { getDb } from './db.js';
import {
  preflight,
  startJob,
  getJob,
  listJobs,
  activeJobId,
  appendNote,
  resumeJob,
  pauseJob,
  archiveJob,
} from './runner.js';
import { git } from './git.js';
import { LIVE, RESUMABLE } from './engine.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const fail = (value) => ({ ...text(value), isError: true });

async function jobFor(id, context) {
  const job = await getJob(id);
  const userId = context.getStore()?.userId;
  if (!job || (userId && job.userId && userId !== job.userId))
    throw new Error('No accessible job with that full ID. Use list_fixes to find it.');
  return job;
}

export function describeJob(job) {
  const id = String(job._id || job.id);
  const status =
    {
      preparing:
        'Preparing the isolated worktree and private dependencies. No model has to wait in this chat.',
      running: 'Claude Code is working in the job worktree.',
      testing: 'The wrapper is testing the committed revision in the job worktree.',
      building:
        'Building an API image from the exact tested commit. The running stack is unchanged.',
      integrating:
        'Integrating tested work into the target branch. Further notes are recorded for follow-up.',
      integrated: 'Source integrated; application has not yet been confirmed.',
      deploying:
        'Applying the tested API image. The chat may disconnect; check this same ID after reconnecting.',
      paused:
        'Paused. Session, commits, and unfinished edits are retained; no partial work was deployed.',
      needs_input:
        'The coding agent needs an answer. Relay its question, add the answer with add_note, then resume_fix.',
      tests_failed:
        'Validation failed. The branch and edits are retained for repair; nothing was integrated or deployed.',
      awaiting_integration:
        'Editing is complete. Integration is waiting; the fix is not live. resume_fix retries this stage.',
      done: 'Done: API image deployed and verified.',
      integrated_only: 'Integrated. No runtime image change was required.',
      applied_pending_restart:
        'Source integrated; runtime/sidecar application remains. This is not a claim that the change is live.',
      no_change: 'Investigation complete; no source change was needed.',
      rolled_back:
        'Deployment failed. The previous API image was restored and the source integration reverted.',
      recovery_required:
        'Automatic recovery is unsafe or incomplete. Inspect the recorded process, source and deployment state before proceeding.',
      archived: 'Closed. Work was preserved under a recovery ref before cleanup.',
      error: 'Supervisor error. Inspect the details; retained isolated jobs can be resumed.',
    }[job.status] || job.status;
  const lines = [`Job \`${id}\` — **${job.status}**. ${status}`];
  if (!job.worktree)
    lines.push(
      'Legacy shared-checkout job: old reports remain readable; its session cannot be resumed under the isolated workflow.',
    );
  if (LIVE.includes(job.status)) {
    const p = job.progress;
    if (p) {
      lines.push(
        `Segment ${job.segment || 1}: ${p.messages ?? '?'} assistant messages, ${p.tools || 0} tool calls. CLI turn limit: ${p.maxTurns || '?'}.`,
      );
      if (p.lastTool) lines.push(`Last tool: ${p.lastTool}`);
      if (p.lastText) lines.push(`Last update: ${p.lastText}`);
    }
    lines.push(
      'Check again in 30–60 seconds or on the next chat turn. Do not file this work again.',
    );
  }
  if (job.summary) lines.push('', job.summary);
  if (job.integrationReason) lines.push('', `Integration: ${job.integrationReason}`);
  if (job.stoppedBecause) lines.push(`Stopped because: ${job.stoppedBecause}`);
  if (job.worktree)
    lines.push(
      '',
      `Branch: \`${job.branch}\``,
      `Worktree: \`${job.worktree}\`${job.cleanedAt ? ' (cleaned)' : ' (retained)'}`,
    );
  if (job.recoveryRef)
    lines.push(
      `Recovery ref: \`${job.recoveryRef}\`. Inspect with \`git show ${job.recoveryRef}\`.`,
    );
  if (job.sessionId) lines.push(`Claude session: \`${job.sessionId}\``);
  if (job.cleanedAt && job.recoveryRef)
    lines.push(
      `Manual recovery in a NEW directory: \`git worktree add --detach <new-directory> ${job.recoveryRef}\`.`,
    );
  if (job.worktree && RESUMABLE.includes(job.status))
    lines.push(`Continue this job with \`resume_fix("${id}")\`.`);
  if (job.commits?.length)
    lines.push('', 'Commits:', ...job.commits.map((c) => `- \`${c.short}\` ${c.subject}`));
  if (job.diffstat) lines.push('', '```', job.diffstat, '```');
  if (job.tests) lines.push('', `Tests: ${job.tests}`);
  if (job.deploy) lines.push('', `Application: ${job.deploy}`);
  if (job.rollback) lines.push('', `Rollback: ${job.rollback}`);
  if (job.recoveryReason) lines.push('', `Recovery detail: ${job.recoveryReason}`);
  if (job.cleanupWarning) lines.push('', `Cleanup deferred: ${job.cleanupWarning}`);
  if (job.buildDirectory) lines.push(`Retained build snapshot: \`${job.buildDirectory}\`.`);
  if (job.imageId) lines.push(`Candidate API image: \`${job.imageId}\`.`);
  if (job.previousImage) lines.push(`Previous API image for recovery: \`${job.previousImage}\`.`);
  if (job.revert)
    lines.push(
      '',
      `Undo source integration: \`${job.revert}\`. Runtime application may also be needed.`,
    );
  if (job.notes?.length)
    lines.push(
      '',
      'Notes:',
      ...job.notes.map(
        (n) =>
          `- ${n.from}: ${n.text}${n.late ? ' [recorded after integration began; not applied to this revision]' : ''}`,
      ),
    );
  if (job.usageLine)
    lines.push(
      '',
      `${job.elapsed || 0}s across ${job.usage?.length || 1} segment(s) · ${job.usageLine}`,
    );
  return lines.join('\n');
}

export async function handleRequestFix({ premise }, context) {
  try {
    if (!premise || premise.trim().length < 8)
      return fail('Describe the requested work or observation in a sentence.');
    const userId = context.getStore()?.userId;
    const limit = Number(process.env.CODE_AGENT_DAILY_LIMIT || 0);
    if (limit > 0 && userId) {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      const db = await getDb();
      const count = await db
        .collection('mcp_code_agent_jobs')
        .countDocuments({ userId, createdAt: { $gte: day } });
      if (count >= limit)
        return fail(
          `Daily limit of ${limit} new jobs reached. Existing jobs can still be inspected or resumed.`,
        );
    }
    const pre = await preflight();
    if (!pre.ok) return fail(pre.reason);
    const id = await startJob({ premise: premise.trim(), userId });
    return text(
      `Job \`${id}\` accepted. Its isolated branch/worktree is being prepared from committed source; the operator's uncommitted edits are excluded.\n\nThe work continues after this tool call and chat turn end. Use check_fix("${id}") in 30–60 seconds or on the next turn; keep this full ID. Do not file it again. Automatic continuation is bounded; paused work is retained for resume_fix.\n\nIf deployment later restarts the API and disconnects the chat, hard-refresh once and check the same job. A started or committed job is not yet a deployed fix.`,
    );
  } catch (err) {
    return fail(`Could not start: ${err.message}`);
  }
}

export async function handleCheckFix({ job_id, include_diff }, context) {
  try {
    const job = await jobFor(job_id, context);
    let result = describeJob(job);
    if (
      include_diff &&
      (job.integrationBase || job.baseSha) &&
      (job.headSha || job.commits?.[0]?.hash)
    ) {
      const { err, stdout, stderr } = await git([
        'diff',
        job.integrationBase || job.baseSha,
        job.headSha || job.commits[0].hash,
      ]);
      result += err
        ? `\n\nDiff unavailable: ${stderr.trim()}`
        : `\n\n\`\`\`diff\n${stdout.slice(0, 60000)}${stdout.length > 60000 ? '\n[diff truncated]' : ''}\n\`\`\``;
    }
    return text(result);
  } catch (err) {
    return fail(err.message);
  }
}

export async function handleAddNote({ job_id, note }, context) {
  try {
    await jobFor(job_id, context);
    if (!note?.trim()) return fail('Provide the correction or answer to record.');
    const receipt = await appendNote(job_id, note.trim(), 'filing agent/user');
    return text(
      receipt.late
        ? `Recorded on ${job_id}. Integration has begun or the job is closed; this note cannot change the revision already in flight. Check its outcome and file follow-up work if needed.`
        : `Recorded as notes version ${receipt.version} on ${job_id}. The coding agent is asked to read it; the wrapper will not integrate a completion report acknowledging an older version. Delivery is deferred until the agent reads the file or resumes. If the job is paused/needs_input/tests_failed/awaiting_integration, use resume_fix on this same ID when ready.`,
    );
  } catch (err) {
    return fail(err.message);
  }
}

export async function handleResumeFix({ job_id }, context) {
  try {
    const job = await jobFor(job_id, context);
    if (!job.worktree)
      return fail(
        'Legacy job: its old session edited the shared checkout and cannot safely resume in a new worktree. Preserve/inspect its existing work before filing a new job.',
      );
    const outcome = await resumeJob(job_id);
    return outcome.ok
      ? text(
          `Resuming ${job_id} in its recorded worktree. ${job.sessionComplete ? 'Retrying validation/integration; the completed investigation is retained.' : 'Continuing the same Claude Code session with its edits and latest notes.'} Check this same ID; deployment is conditional on completion and successful validation.`,
        )
      : fail(outcome.reason);
  } catch (err) {
    return fail(err.message);
  }
}

export async function handlePauseFix({ job_id }, context) {
  try {
    await jobFor(job_id, context);
    return text(await pauseJob(job_id));
  } catch (err) {
    return fail(err.message);
  }
}

export async function handleArchiveFix({ job_id }, context) {
  try {
    await jobFor(job_id, context);
    const job = await archiveJob(job_id);
    return text(
      `Archived ${job_id}. Recovery ref: ${job.recoveryRef}. ${job.cleanedAt ? 'Worktree removed; source work remains recoverable from that ref.' : `Worktree retained: ${job.cleanupWarning}`}`,
    );
  } catch (err) {
    return fail(err.message);
  }
}

export async function handleListFixes({ limit }, context) {
  try {
    const jobs = await listJobs(context.getStore()?.userId, limit);
    const rows = jobs.map(
      (j) =>
        `- \`${j._id}\` ${new Date(j.createdAt).toISOString().slice(0, 16)} UTC — **${j.status}**${j.worktree && !j.cleanedAt ? ' [worktree retained]' : ''} — ${j.premise?.split('\n')[0]?.slice(0, 120) || ''}`,
    );
    return text(
      [
        ...rows,
        '',
        activeJobId() ? `Active job: ${activeJobId()}.` : 'No active job.',
        'Use the full ID with check_fix. Retained jobs can be resumed or explicitly archived; do not file duplicates.',
      ].join('\n'),
    );
  } catch (err) {
    return fail(err.message);
  }
}
