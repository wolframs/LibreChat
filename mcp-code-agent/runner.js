import { ObjectId } from 'mongodb';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { buildPrompt, buildResumePrompt } from './prompt.js';
import {
  REPO,
  BRANCH,
  run,
  git,
  head,
  currentBranch,
  porcelain,
  commitsSince,
  diffstat,
  filesChanged,
  revert,
  revertCommand,
} from './git.js';
import { renderEntry, writeEntry } from './changelog.js';
import { addTokens, tokensFrom, describeTokens } from './tokens.js';
import fs from 'fs/promises';
import os from 'os';

/**
 * Where a note filed *after* a job started is left for the agent to find.
 *
 * Deliberately outside the repository: anything written inside it is a dirty
 * working tree at best and swept into the agent's own commit at worst. The
 * briefing tells the agent to re-read this path before committing, which is what
 * makes a mid-flight correction possible at all — a headless `claude -p` session
 * has no input channel once it has started, so the file is the channel.
 */
const NOTES_DIR = path.join(os.homedir(), '.cache', 'librechat-code-agent', 'notes');
const notesPathFor = (jobId) => path.join(NOTES_DIR, `${jobId}.md`);

export async function appendNote(jobId, note, from) {
  await fs.mkdir(NOTES_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await fs.appendFile(
    notesPathFor(jobId),
    `## Note added ${stamp} UTC${from ? ` by ${from}` : ''}\n\n${note.trim()}\n\n`,
  );
  const db = await getDb();
  await db
    .collection('mcp_code_agent_jobs')
    .updateOne(
      { _id: new ObjectId(jobId) },
      { $push: { notes: { at: new Date(), from: from ?? null, text: note.trim() } } },
    );
  return notesPathFor(jobId);
}

/** Empty means "whatever the installed Claude Code defaults to", which is right. */
export const MODEL = process.env.CODE_AGENT_MODEL || '';

/**
 * That the host CLI exists and is authenticated, checked before anything is
 * spawned. `claude --version` costs nothing and catches a missing binary or a
 * broken PATH — the two ways a launchd-started process differs from a shell.
 */
export async function agentAvailable() {
  const { err, stdout } = await run('claude', ['--version'], { timeout: 20_000 });
  if (err) {
    return `The \`claude\` CLI is not runnable from this process: ${err.message}. ` +
      'Check PATH — a launchd agent does not inherit a login shell.';
  }
  console.log(`claude available: ${stdout.trim().split('\n')[0]}`);
  return null;
}
/**
 * 80 was far too low and cost $8 to learn: a real investigation spent every one
 * of them reading code and never reached the fix, then exited non-zero with the
 * work discarded. The wall clock is the better bound — it fails at a predictable
 * cost — so this is high enough to be a backstop rather than a guillotine, and
 * the agent is told its budget so it can spend it deliberately.
 */
const MAX_TURNS = parseInt(process.env.CODE_AGENT_MAX_TURNS ?? '250', 10);
const AGENT_TIMEOUT_MS = parseInt(process.env.CODE_AGENT_TIMEOUT_SEC ?? '2700', 10) * 1000;
const DEPLOY_TIMEOUT_MS = parseInt(process.env.CODE_AGENT_DEPLOY_TIMEOUT_SEC ?? '1800', 10) * 1000;
const CONTEXT_MESSAGES = parseInt(process.env.CODE_AGENT_CONTEXT_MESSAGES ?? '12', 10);

/**
 * One job at a time, process-wide.
 *
 * The agent edits the real working tree — that is what makes "it is actually
 * deployed when this says done" possible at all — so two concurrent jobs would be
 * two agents editing the same files and one commit sweeping up the other's
 * half-finished work. The lock is in-process because there is exactly one of
 * these containers; if that ever stops being true this needs to move to Mongo.
 */
let activeJob = null;

export function activeJobId() {
  return activeJob;
}

async function setJob(id, patch) {
  const db = await getDb();
  await db
    .collection('mcp_code_agent_jobs')
    .updateOne({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } });
}

export async function getJob(id) {
  const db = await getDb();
  try {
    return await db.collection('mcp_code_agent_jobs').findOne({ _id: new ObjectId(id) });
  } catch {
    return null;
  }
}

export async function listJobs(userId, limit) {
  const db = await getDb();
  return db
    .collection('mcp_code_agent_jobs')
    .find(userId ? { userId } : {})
    .project({ premise: 1, status: 1, createdAt: 1, summary: 1, revert: 1 })
    .sort({ createdAt: -1 })
    .limit(limit || 10)
    .toArray();
}

/**
 * Which conversation filed this, found from the user rather than passed in.
 *
 * The obvious way to know is a `{{LIBRECHAT_BODY_CONVERSATIONID}}` header, and it
 * cannot be used: a BODY placeholder makes the connection *require* a chat
 * request body carrying that field (UserConnectionManager.getUserConnection ->
 * getMissingRuntimeBodyPlaceholderFields), and enabling a server from the chat
 * MCP dropdown is a reinitialize with no body at all. The result is a hard
 * `MCP error -32600` and a "failed to initialize MCP server" popup, so the server
 * can never be switched on in the one place it is meant to be switched on.
 *
 * So: the caller's most recently touched conversation. That is a heuristic, and
 * it is bounded rather than trusted — a conversation that has not moved in
 * MAX_CONTEXT_AGE_MIN is not plausibly the one being typed in, and handing the
 * agent a stale transcript as evidence is worse than handing it none. When the
 * window lapses the job simply runs on the premise alone, which is the input the
 * whole design is built to accept anyway.
 */
const MAX_CONTEXT_AGE_MIN = parseInt(process.env.CODE_AGENT_CONTEXT_MAX_AGE_MIN ?? '30', 10);

async function activeConversation(userId) {
  if (!userId) return null;
  try {
    const db = await getDb();
    const c = await db
      .collection('conversations')
      .findOne(
        { user: userId },
        { sort: { updatedAt: -1 }, projection: { conversationId: 1, endpoint: 1, model: 1, updatedAt: 1 } },
      );
    if (!c) return null;
    const ageMin = (Date.now() - new Date(c.updatedAt).getTime()) / 60000;
    if (ageMin > MAX_CONTEXT_AGE_MIN) {
      console.log(`newest conversation is ${Math.round(ageMin)}m old — running without context`);
      return null;
    }
    return {
      conversationId: c.conversationId,
      sender: [c.endpoint, c.model].filter(Boolean).join(' / ') || null,
    };
  } catch (err) {
    console.error('conversation lookup failed:', err.message);
    return null;
  }
}

/** Raw transcript around the premise, so the sender never has to curate evidence. */
async function conversationContext(conversationId) {
  if (!conversationId) return [];
  try {
    const db = await getDb();
    const rows = await db
      .collection('messages')
      .find({ conversationId })
      .project({ text: 1, sender: 1, isCreatedByUser: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(CONTEXT_MESSAGES)
      .toArray();
    return rows
      .reverse()
      .filter((m) => m.text)
      .map((m) => ({
        who: m.isCreatedByUser ? 'user' : m.sender || 'assistant',
        text: m.text.length > 4000 ? `${m.text.slice(0, 4000)}\n[…truncated]` : m.text,
      }));
  } catch (err) {
    console.error('context fetch failed:', err.message);
    return [];
  }
}

/**
 * Refusals that have to happen before an agent is spawned, each returning the
 * evidence rather than a verdict — the model asking should be able to tell its
 * user *what* is in the way, not just that something is.
 */
export async function preflight() {
  // Claude Code refuses --dangerously-skip-permissions as root, and there is no
  // reason for this to ever run as root now that it is a plain user process.
  if (process.getuid() === 0) {
    return {
      ok: false,
      reason:
        'The sidecar is running as root, and Claude Code refuses ' +
        '--dangerously-skip-permissions as root. Run it as the operator instead.',
    };
  }
  const agentIssue = await agentAvailable();
  if (agentIssue) return { ok: false, reason: agentIssue };
  if (activeJob) {
    return { ok: false, reason: `A fix is already running (job ${activeJob}). Wait for it.` };
  }
  const branch = await currentBranch();
  if (branch !== BRANCH) {
    return {
      ok: false,
      reason:
        `The repository is on '${branch}', not '${BRANCH}'. Deploying from the wrong branch ` +
        'silently ships a stack missing every local feature, so nothing will run until a ' +
        'human checks out the right branch.',
    };
  }
  const dirty = await porcelain();
  if (dirty) {
    return {
      ok: false,
      reason:
        'The working tree has uncommitted changes, so a fix would sweep them into its own ' +
        'commit and they would ship without anyone deciding to ship them. Ask the user to ' +
        `commit or stash these first:\n\n${dirty}`,
    };
  }
  return { ok: true };
}

// Resolved from this module, not hardcoded. It was '/app/agent-settings.json',
// which was the path inside the container that no longer exists — the flag then
// pointed at nothing and Claude Code refused to start at all. A path that only
// makes sense in a deployment shape you have left is worse than no path.
const SETTINGS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-settings.json');

function claudeArgs(prompt, resumeSessionId) {
  return [
    // A cut-off session is still a session: resuming carries every file it read
    // and every conclusion it reached, so an interrupted investigation is worth
    // a message rather than a whole new run.
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    '-p',
    prompt,
    // NDJSON rather than one JSON blob at the end, which is what makes a running
    // job observable: every tool use and every turn arrives while it is still
    // happening, instead of the wrapper having nothing to report but "started".
    '--output-format',
    'stream-json',
    '--verbose',
    ...(MODEL ? ['--model', MODEL] : []),
    '--max-turns',
    String(MAX_TURNS),
    // Deny rules only — the short list of things `git revert` cannot undo.
    '--settings',
    SETTINGS,
    // Nobody is present to answer a permission prompt, so there is no useful
    // interactive mode here. What bounds this is the deny list plus the fact
    // that everything it does is a commit `git revert` undoes.
    '--dangerously-skip-permissions',
  ];
}

/**
 * Run the agent, reporting what it is doing while it does it.
 *
 * The first version used execFile and a single JSON blob, so a job in flight was
 * a black box: `check_fix` could say "still working" and nothing else, and the
 * only real information arrived after the process had exited. A model watching
 * its own repair had no more insight than `ps`.
 *
 * `onProgress` is called with a rolling summary — turn count, the tool running
 * right now, the files touched so far, the agent's last words. The caller
 * throttles the writes; this just parses.
 */
function runAgent(prompt, onProgress, resumeSessionId) {
  return new Promise((resolve) => {
    const child = spawn('claude', claudeArgs(prompt, resumeSessionId), {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const progress = {
      turns: 0,
      maxTurns: MAX_TURNS,
      tools: 0,
      lastTool: null,
      files: [],
      lastText: null,
      tokens: null,
      phase: 'starting',
    };
    let stderr = '';
    let buffer = '';
    let result = null;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, AGENT_TIMEOUT_MS);

    const note = (event) => {
      if (event.type === 'system' && event.subtype === 'init') {
        progress.phase = 'working';
        progress.sessionId = event.session_id ?? null;
        progress.model = event.model ?? null;
      } else if (event.type === 'assistant') {
        progress.turns += 1;
        progress.tokens = addTokens(progress.tokens, event.message?.usage);
        for (const part of event.message?.content ?? []) {
          if (part.type === 'text' && part.text?.trim()) {
            progress.lastText = part.text.trim().slice(-400);
          } else if (part.type === 'tool_use') {
            progress.tools += 1;
            // The file path is the useful half of a tool call for a watcher;
            // the rest is noise at this level of detail.
            const target =
              part.input?.file_path ?? part.input?.pattern ?? part.input?.command ?? '';
            progress.lastTool = `${part.name}${target ? ` ${String(target).slice(0, 120)}` : ''}`;
            const f = part.input?.file_path;
            if (f && !progress.files.includes(f)) progress.files.push(f);
          }
        }
      } else if (event.type === 'result') {
        result = event;
        progress.phase = 'finishing';
      }
      onProgress({ ...progress, files: [...progress.files], tokens: progress.tokens ? { ...progress.tokens } : null });
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          note(JSON.parse(line));
        } catch {
          /* a partial or non-JSON line; the stream is best-effort telemetry */
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ result, code, stderr, timedOut, progress });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ result: null, code: -1, stderr: `${stderr}\n${err.message}`, timedOut, progress });
    });
  });
}

/**
 * Restart a job whose session ran out of turns, in that same session.
 *
 * The job document is reused rather than a new one created: it is the same
 * premise, the same notes and the same base commit, and splitting it in two
 * would make the changelog claim two pieces of work where there was one.
 */
export async function resumeJob(jobId) {
  const job = await getJob(jobId);
  if (!job) return { ok: false, reason: `No job \`${jobId}\`.` };
  const sessionId = job.progress?.sessionId;
  if (!sessionId) {
    return {
      ok: false,
      reason:
        'That job recorded no session id, so there is nothing to resume — it died before ' +
        'the session started. File it again instead.',
    };
  }
  if (['running', 'testing', 'deploying'].includes(job.status)) {
    return { ok: false, reason: `Job \`${jobId}\` is still ${job.status}.` };
  }
  const pre = await preflight();
  if (!pre.ok) return pre;

  activeJob = jobId;
  await setJob(jobId, { status: 'running', resumedAt: new Date(), resumeCount: (job.resumeCount ?? 0) + 1 });

  execute(jobId, {
    premise: job.premise,
    userId: job.userId,
    resumeSessionId: sessionId,
    baseSha: job.baseSha,
    previousTurns: job.progress?.turns ?? 0,
  }).catch(async (err) => {
    console.error(`resume ${jobId} crashed:`, err);
    await setJob(jobId, { status: 'error', summary: `Resume crashed: ${err.message}` });
    activeJob = null;
  });

  return { ok: true, sessionId };
}

export async function startJob({ premise, userId }) {
  const db = await getDb();
  const { insertedId } = await db.collection('mcp_code_agent_jobs').insertOne({
    premise,
    userId,
    model: MODEL,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const jobId = insertedId.toString();
  activeJob = jobId;

  // Deliberately not awaited: the deploy inside this will drop the very SSE
  // connection the caller is holding, so the tool has to have returned long
  // before we get there. This container is not recreated by deploy.sh, so the
  // job outlives the api restart and is still here to be collected afterwards.
  execute(jobId, { premise, userId }).catch(async (err) => {
    console.error(`job ${jobId} crashed:`, err);
    await setJob(jobId, { status: 'error', summary: `Job crashed: ${err.message}` });
    activeJob = null;
  });

  return jobId;
}

async function execute(jobId, { premise, userId, resumeSessionId, baseSha: existingBase, previousTurns }) {
  // On a resume the ORIGINAL base is reused, so commits made before the cut-off
  // are still counted as this job's work rather than treated as pre-existing.
  const baseSha = existingBase ?? (await head());
  await setJob(jobId, { baseSha });

  const active = await activeConversation(userId);
  const sender = active?.sender ?? null;
  const conversation = await conversationContext(active?.conversationId);
  await setJob(jobId, { sender, conversationId: active?.conversationId ?? null });
  const prompt = resumeSessionId
    ? buildResumePrompt({ notesPath: notesPathFor(jobId), maxTurns: MAX_TURNS, previousTurns })
    : buildPrompt({
        premise,
        sender,
        conversation,
        notesPath: notesPathFor(jobId),
        maxTurns: MAX_TURNS,
      });

  console.log(
    `[${jobId}] ${resumeSessionId ? `resuming ${resumeSessionId}` : 'running'} from ${baseSha.slice(0, 9)}`,
  );
  const started = Date.now();
  // No credential passed and none wanted: this runs as the operator, so the
  // `claude` on PATH is the one already installed and logged in on this Mac.
  let lastWrite = 0;
  const { result, code, stderr, timedOut } = await runAgent(
    prompt,
    (progress) => {
    // Throttled: the stream is chatty and every write is a round trip, but a
    // watcher refreshing every few seconds should still see movement.
      const now = Date.now();
      if (now - lastWrite < 2000) return;
      lastWrite = now;
      setJob(jobId, {
        progress: { ...progress, sessionId: progress.sessionId ?? resumeSessionId, at: new Date() },
      }).catch(() => {});
    },
    resumeSessionId,
  );
  const elapsed = Math.round((Date.now() - started) / 1000);

  const report = result?.result || '';
  const cost = result?.total_cost_usd ?? null;
  // The result event's own usage is authoritative; the per-message sum is only
  // there so a watcher sees movement before the run ends.
  const tokens = tokensFrom(result?.usage);
  const modelName = Object.keys(result?.modelUsage ?? {})[0] ?? null;
  const usageLine = describeTokens(tokens, { cost, model: modelName });
  const err = code !== 0 || result?.is_error ? { code, killed: timedOut } : null;

  // The stream's final event says exactly why it stopped; `exit 1` says nothing
  // and is what the first version reported for a run that had simply used up its
  // turns. Whoever reads this next should not have to guess.
  const REASONS = {
    error_max_turns:
      `The agent used all ${MAX_TURNS} of its turns and was cut off before it finished. ` +
      'It was not failing — it ran out of room. Raise CODE_AGENT_MAX_TURNS, or file a ' +
      'narrower premise.',
    error_during_execution: 'The agent hit an internal error part-way through.',
  };
  const why = result?.subtype && result.subtype !== 'success' ? REASONS[result.subtype] ?? `The agent stopped: ${result.subtype}.` : null;

  // Work already committed is not thrown away just because the run ended badly.
  // 810 seconds and $8 of investigation were discarded the first time this
  // happened, and if that run had committed anything the commits would have been
  // orphaned in the tree for the operator's next deploy to ship unannounced.
  const earlyCommits = err ? await commitsSince(baseSha) : [];
  if (err && earlyCommits.length === 0) {
    await finish(jobId, {
      status: 'error',
      summary:
        (why ??
          `The agent did not finish (${err.killed ? `timed out after ${AGENT_TIMEOUT_MS / 1000}s` : `exit ${err.code}`}).`) +
        (report ? `\n\nWhat it had to say before stopping:\n\n${report}` : '') +
        `\n\nIt made no commits, so nothing changed.` +
        ((stderr || '').trim() ? `\n\n${stderr.trim().slice(-1200)}` : ''),
      stoppedBecause: result?.subtype ?? null,
      cost,
      tokens,
      usageLine,
      elapsed,
    });
    return;
  }

  const commits = err ? earlyCommits : await commitsSince(baseSha);
  const cutOff = err ? why ?? 'The agent stopped before finishing.' : null;

  // An agent that looked and found nothing wrong is a real answer, and the tree
  // is already exactly where it started, so there is nothing to deploy.
  if (!commits.length) {
    const entry = renderEntry({
      jobId,
      premise,
      sender,
      report,
      commits: [],
      diffstat: '',
      tests: 'n/a',
      deploy: 'not needed — no change',
      usageLine,
    });
    await writeEntry(entry, jobId);
    await finish(jobId, { status: 'no_change', summary: report, cost, tokens, usageLine, elapsed, commits: [] });
    return;
  }

  const stat = await diffstat(baseSha);
  const files = await filesChanged(baseSha);
  await setJob(jobId, { status: 'testing', commits, diffstat: stat, files, report });

  /**
   * The wrapper runs the tests itself, even though the briefing told the agent to.
   *
   * Not distrust — logistics. "Tests were green at deploy time" is a fact about
   * the tree as it stands now, and only a run now establishes it. An agent that
   * tested honestly three commits ago and then fixed one more thing has not
   * lied about anything, and this still catches it.
   */
  const tests = await runTests(files);
  await setJob(jobId, { tests: tests.text });

  if (!tests.ok) {
    // Nothing was deployed, so there is nothing to roll back — but the commits
    // exist, and leaving them in the tree would mean the *human's* next deploy
    // ships code that failed its tests. Undo them here.
    const reverted = await revert(commits);
    const entry = renderEntry({
      jobId,
      premise,
      sender,
      report: `${report}\n\n**The wrapper's own test run failed after the agent finished, so nothing was deployed and the commits were reverted.**\n\n${tests.text}`,
      commits,
      diffstat: stat,
      tests: tests.text,
      deploy: 'not attempted — tests failed',
      usageLine,
    });
    await writeEntry(entry, jobId);
    await finish(jobId, {
      status: reverted.err ? 'broken' : 'tests_failed',
      summary:
        `${report}\n\nThe wrapper re-ran the tests before deploying and they failed, so ` +
        `nothing was deployed${reverted.err ? ' AND THE REVERT FAILED — the stack needs a human' : ' and the commits were reverted'}.\n\n${tests.text}`,
      cost,
      tokens,
      usageLine,
      elapsed,
      commits,
    });
    return;
  }

  await setJob(jobId, { status: 'deploying' });

  // A change to this sidecar's own source cannot deploy itself: deploy.sh does
  // not rebuild sidecars, and the rebuild that would apply it kills the container
  // running this job. Commit it, say so, and let a human do the last step.
  const selfEdit = files.some((f) => f.startsWith('mcp-code-agent/'));
  const deployResult = selfEdit
    ? {
        ok: true,
        text:
          'skipped — this change is to the code-agent sidecar itself, which cannot rebuild ' +
          'the container it is running in. Committed and tested; apply it with ' +
          '`docker compose up -d --build mcp-code-agent`.',
      }
    : await deploy();

  let status = deployResult.ok ? 'done' : 'rolled_back';
  let rollbackNote = '';

  if (!deployResult.ok) {
    // The stack failing verification is the one case that must self-correct: a
    // broken api is a stack the user cannot even talk to a model on, so nobody
    // is left who could ask for the fix to be undone. Undo it here.
    console.error(`[${jobId}] deploy failed, reverting`);
    const reverted = await revert(commits);
    const redeploy = reverted.err ? { ok: false, text: 'revert failed' } : await deploy();
    rollbackNote = reverted.err
      ? `\n\nAUTOMATIC ROLLBACK FAILED: ${reverted.stderr.trim().slice(-500)}\nThe stack needs a human.`
      : redeploy.ok
        ? '\n\nThe change was automatically reverted and the previous version redeployed. The stack is back to where it was.'
        : `\n\nThe revert committed but redeploying it also failed. The stack needs a human.\n${redeploy.text}`;
    if (reverted.err || !redeploy.ok) status = 'broken';
  }

  const entry = renderEntry({
    jobId,
    premise,
    sender,
    report: (cutOff ? `**${cutOff} What follows is the work it had committed before that.**\n\n` : '') + report + rollbackNote,
    commits,
    diffstat: stat,
    tests: 'run by the agent; see its report',
    deploy: deployResult.text,
    usageLine,
  });
  await writeEntry(entry, jobId);

  await finish(jobId, {
    status,
    tokens,
    usageLine,
    summary: (cutOff ? `**${cutOff} What follows is the work it had committed before that.**\n\n` : '') + report + rollbackNote,
    deploy: deployResult.text,
    cost,
    elapsed,
    commits,
  });
}

/**
 * Map the touched files onto workspaces and test those. Running everything would
 * take long enough that the job would look hung; running nothing would make the
 * gate above decorative.
 */
const WORKSPACES = ['packages/api', 'packages/data-provider', 'packages/data-schemas', 'api', 'client'];

async function runTests(files) {
  const touched = WORKSPACES.filter((ws) => files.some((f) => f.startsWith(`${ws}/`)));
  if (!touched.length) {
    return { ok: true, text: 'no workspace with tests was touched — nothing to run' };
  }

  const results = [];
  for (const ws of touched) {
    const { err, stdout, stderr } = await run('./scripts/agent-test.sh', [ws], {
      timeout: 900_000,
    });
    const out = `${stdout}\n${stderr}`.trim();
    if (err) {
      return { ok: false, text: `\`agent-test.sh ${ws}\` failed:\n\n${out.slice(-3000)}` };
    }
    results.push(out.split('\n').filter(Boolean).slice(-5).join(' · '));
  }
  return { ok: true, text: results.join('\n') };
}

async function deploy() {
  console.log('running deploy.sh');
  const { err, stdout, stderr } = await run('./scripts/deploy.sh', ['--yes'], {
    timeout: DEPLOY_TIMEOUT_MS,
  });
  const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-25).join('\n');
  return err
    ? { ok: false, text: `FAILED (${err.killed ? 'timed out' : `exit ${err.code}`})\n\n${tail}` }
    : { ok: true, text: 'ok — /health, both sidecars, and all feature markers verified' };
}

async function finish(jobId, patch) {
  await setJob(jobId, {
    ...patch,
    revert: patch.commits?.length ? revertCommand(patch.commits) : null,
    finishedAt: new Date(),
  });
  activeJob = null;
  console.log(`[${jobId}] ${patch.status}`);
}

export { REPO };
