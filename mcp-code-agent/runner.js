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
const AGENT_NAME = 'LibreChat code-agent';
const AGENT_EMAIL = 'code-agent@librechat.local';

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

/**
 * The lock dies with the process; the Mongo row does not.
 *
 * A restart mid-run — `launchctl kickstart` to pick up an edit, a crash, a
 * reboot — kills the child `claude` and leaves the job's row saying `running`
 * forever. Nothing else ever corrects it, and every instrument then lies in the
 * same direction: /agent shows a pulsing live card and refreshes every 5s for a
 * job with no process, `check_fix` reports it as still working, and `resume_fix`
 * refuses it as "still running" — so the one session that *is* recoverable is the
 * one you cannot reach. Job 6aa10a5663687a981bbfb6a3 sat like that for 6½ hours
 * on 2026-09-09.
 *
 * Because the lock is in-process, any row still in a live state at boot is by
 * definition orphaned: there is no process it could belong to. So this is safe
 * to run unconditionally at startup, and it is the only place that knows.
 */
export async function reapOrphanedJobs() {
  const db = await getDb();
  const orphans = await db
    .collection('mcp_code_agent_jobs')
    .find({ status: { $in: ['running', 'testing', 'deploying'] } })
    .project({ status: 1, progress: 1 })
    .toArray();

  for (const job of orphans) {
    const id = String(job._id);
    const session = job.progress?.sessionId;
    await setJob(id, {
      status: 'error',
      stoppedBecause: 'process_restarted_mid_run',
      summary:
        `Cut off at status \`${job.status}\` by a restart of this server, not by anything ` +
        'it did. The child `claude` process died with it.\n\n' +
        (session
          ? `Its Claude Code session \`${session}\` is intact on disk, so ` +
            `\`resume_fix("${id}")\` picks it up where it stopped.`
          : 'It recorded no session id, so there is nothing to resume — file it again.') +
        '\n\nCheck the tree before resuming: a job killed mid-edit can leave uncommitted work.',
    });
    console.log(`[${id}] was ${job.status} at boot with no process — marked error`);
  }
  return orphans.length;
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
/**
 * Commits made since `sinceSha` that this agent actually authored.
 *
 * The author filter is the safety net under the segment boundary: even if the
 * boundary were wrong again, a human's commit can never end up in a set the
 * wrapper is willing to revert.
 */
async function ownCommitsSince(sinceSha, jobId) {
  const { stdout } = await git([
    'log',
    '--format=%H%x00%an%x00%s',
    `${sinceSha}..HEAD`,
  ]);
  const all = stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, author, subject] = line.split('\0');
    return { hash, short: hash.slice(0, 9), subject, author };
  });
  const mine = all.filter((c) => c.author === AGENT_NAME);
  const foreign = all.filter((c) => c.author !== AGENT_NAME);
  if (foreign.length) {
    console.warn(
      `[${jobId}] ignoring ${foreign.length} commit(s) by someone else in this range: ` +
        foreign.map((c) => `${c.short} (${c.author})`).join(', '),
    );
  }
  return mine;
}

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
  if (await porcelain()) {
    const parked = await parkWorkingTree();
    if (!parked.ok) return parked;
    return { ok: true, parked: parked.parked };
  }
  return { ok: true };
}

/**
 * Files that must never be swept into an automatic commit.
 *
 * All three are ignored, so `porcelain()` cannot list them and this can only
 * fire if somebody force-added one. That is exactly the case worth refusing:
 * `searxng/settings.yml` holds a live Brave key, `.env` holds both Surplus keys.
 */
const NEVER_COMMIT = [/(^|\/)\.env($|\.)/, /^librechat\.yaml$/, /^searxng\/settings\.yml$/];

/**
 * Commit whatever is in the tree, as the operator, before the agent starts.
 *
 * This used to be a refusal: "the working tree has uncommitted changes, ask the
 * user to commit or stash them first." The reasoning was that the image builds
 * from the working tree, so uncommitted work would ship without anyone deciding
 * to ship it — and that half is true. The conclusion was not. Git is the undo
 * button; a commit is how you make something revertible, not how you make it
 * dangerous. Refusing left the work in exactly the state that has no record.
 *
 * It cost a run on 2026-09-09: the operator had a preset-import feature in the
 * tree — already built and deployed by another agent, and therefore already live
 * in the stack while existing nowhere in git — and the sidecar refused to start
 * because of it. The refusal protected nothing. The code was running.
 *
 * So: `git add -A` and commit it under the operator's own identity. Three things
 * make that safe rather than reckless, and all three already existed —
 *
 *   - The commit is authored by the operator, and `ownCommitsSince` only ever
 *     collects commits authored by `LibreChat code-agent`. The revert path
 *     cannot touch it, however badly the job goes.
 *   - `baseSha` is read after this, so the agent's diff starts above it. The
 *     parked work is never part of what the job claims to have done.
 *   - It is one commit with one subject, so undoing it is one `git revert`.
 *
 * What it does not do is decide whether that work is *ready*. It ships in the
 * deploy at the end of the job, same as everything else in the tree — which is
 * what would have happened anyway, minus the record.
 */
async function parkWorkingTree() {
  const { stdout: name } = await git(['config', 'user.name']);
  const { stdout: email } = await git(['config', 'user.email']);
  const author = `${name.trim() || 'operator'} <${email.trim() || 'operator@localhost'}>`;

  const { err: addErr, stderr: addOut } = await git(['add', '-A']);
  if (addErr) {
    return { ok: false, reason: `Could not stage the working tree: ${addOut.trim()}` };
  }

  // The staged list, from git, rather than a parse of `git status --porcelain`.
  // The first version sliced three characters off each porcelain line to strip
  // the status code — and `porcelain()` trims its output, so the leading space
  // of the *first* line was already gone and that line lost its first character.
  // Cosmetic in the log; not cosmetic in the check below, where ` M .env` would
  // have arrived as `nv` and matched nothing.
  const { stdout: staged } = await git(['diff', '--cached', '--name-only']);
  const paths = staged.split('\n').map((p) => p.trim()).filter(Boolean);

  const forbidden = paths.filter((p) => NEVER_COMMIT.some((re) => re.test(p)));
  if (forbidden.length) {
    await git(['reset']);
    return {
      ok: false,
      reason:
        `The working tree has changes to ${forbidden.join(', ')}, which carry live ` +
        'credentials and are supposed to be ignored. Something has force-added them. ' +
        'Sort that out by hand — this will not commit them.',
    };
  }

  if (!paths.length) {
    return { ok: true, parked: null };
  }

  const subject = 'WIP: tree as found when a code-agent job started';
  const body =
    `${paths.length} path(s) were uncommitted when a code-agent job began, so they are ` +
    'committed here to keep them separate from the agent\'s own work and revertible on ' +
    `their own.\n\n${paths.map((p) => `  ${p}`).join('\n')}\n`;

  // GIT_AUTHOR_* is set process-wide once a job has run (see the env block in
  // execute()), which would stamp this with the agent's name and make the revert
  // path treat the operator's work as the job's own. --author wins over that.
  const { err, stderr } = await git([
    'commit',
    '--author',
    author,
    '-m',
    subject,
    '-m',
    body,
  ]);
  if (err) {
    return { ok: false, reason: `Could not commit the working tree: ${stderr.trim().slice(-800)}` };
  }

  const sha = (await head()).slice(0, 9);
  console.log(`[preflight] parked ${paths.length} uncommitted path(s) as ${sha}`);
  return { ok: true, parked: { sha, paths, author, subject } };
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
  await setJob(jobId, {
    status: 'running',
    resumedAt: new Date(),
    resumeCount: (job.resumeCount ?? 0) + 1,
    ...(pre.parked ? { parked: pre.parked } : {}),
  });

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

  return { ok: true, sessionId, parked: pre.parked ?? null };
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
  // The boundary for THIS run, which is not the job's original base. Between a
  // cut-off and its resume, other people commit to the same branch — and using
  // the original base swept three of the operator's own commits into a job's
  // "work", then reverted them when the tests failed. A segment can only ever
  // contain commits made while the agent was actually running.
  const segmentBase = await head();
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
  // Restored from the container version, which set this in the image: every
  // commit the agent makes is authored `LibreChat code-agent`, so
  // `git log --author=code-agent` separates model work from human work — and,
  // more importantly, the revert path can refuse to touch anything else.
  process.env.GIT_AUTHOR_NAME = AGENT_NAME;
  process.env.GIT_AUTHOR_EMAIL = AGENT_EMAIL;
  process.env.GIT_COMMITTER_NAME = AGENT_NAME;
  process.env.GIT_COMMITTER_EMAIL = AGENT_EMAIL;

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
  const earlyCommits = err ? await ownCommitsSince(segmentBase, jobId) : [];
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

  const priorCommits = (await getJob(jobId))?.commits ?? [];
  const segmentCommits = err ? earlyCommits : await ownCommitsSince(segmentBase, jobId);
  // Everything this job has produced across all of its runs — which is what the
  // changelog should show, and the only thing the revert path may touch.
  const commits = [...segmentCommits, ...priorCommits];
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
  /**
   * Anything the agent left uncommitted is set aside before the tests run.
   *
   * This is the bug that cost eight commits: the gate tests the working tree,
   * but the remedy only undoes commits. A half-finished edit left behind by a
   * cut-off agent made 22 tests fail in files the diff never touched, and the
   * wrapper responded by reverting every commit in range — which could not
   * possibly have fixed it, and destroyed good work instead. It is also what
   * would have shipped, since the image builds from the working tree.
   *
   * `git stash` rather than discard: it is recoverable with one command, and
   * throwing away an agent's unfinished thought is not the wrapper's call.
   */
  let stashed = null;
  const leftovers = await porcelain();
  if (leftovers) {
    const label = `code-agent job ${jobId} leftovers`;
    const { err: stashErr } = await git(['stash', 'push', '-u', '-m', label]);
    stashed = stashErr ? null : label;
    console.log(`[${jobId}] set aside uncommitted leftovers: ${stashed ?? 'STASH FAILED'}`);
    await setJob(jobId, {
      stashed,
      leftovers: leftovers.split('\n').slice(0, 40),
    });
  }

  const tests = await runTests(files);
  await setJob(jobId, { tests: tests.text, flakySuites: tests.flaky ?? [] });

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
    tests: tests.text,
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

/**
 * How many flaky-looking suites are worth isolating before giving up.
 *
 * A handful is a flaky harness. Thirty is a workspace the change actually broke,
 * and re-running thirty suites one at a time to prove it would take longer than
 * the run that found them.
 */
const ISOLATION_BUDGET = 8;

/** The suite paths from `agent-test.sh`'s `FAIL <path>` lines — not its `FAIL <workspace>` heading. */
function failingSuites(out) {
  const paths = out
    .split('\n')
    .map((line) => line.match(/^FAIL\s+(\S+\.(?:spec|test)\.[cm]?[jt]sx?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
  return [...new Set(paths)];
}

/**
 * Build any touched `packages/*` before testing anything that consumes it.
 *
 * `api` and `client` resolve `@librechat/api` through its package `main`, which
 * is `packages/api/dist/index.cjs` — not `src`. So a change that adds an export
 * to `packages/api/src` is invisible to the `api` workspace's tests until that
 * package is rebuilt, and they fail with `X is not a function` in whatever file
 * uses it. The Dockerfile builds the packages during the image build, so the
 * same change deploys and runs correctly; only the gate sees the stale copy.
 *
 * That is not a flake to be isolated away — it is deterministic, and it fails
 * the change that is most obviously correct. It reverted the datetime work on
 * 2026-09-09: `createDatetimeFormatter is not a function`, 15 tests, from a dist
 * built before the function existed.
 */
async function buildTouchedPackages(files) {
  const pkgs = [...new Set(
    files
      .map((f) => f.match(/^(packages\/[^/]+)\//))
      .filter(Boolean)
      .map((m) => m[1]),
  )];

  const built = [];
  for (const pkg of pkgs) {
    const { err, stderr } = await run('npm', ['run', 'build'], {
      cwd: `${REPO}/${pkg}`,
      timeout: 600_000,
    });
    if (err) {
      return { ok: false, pkg, text: `\`npm run build\` failed in ${pkg}:\n\n${stderr.trim().slice(-2000)}` };
    }
    built.push(pkg);
    console.log(`[tests] rebuilt ${pkg} so its consumers see this change`);
  }
  return { ok: true, built };
}

async function testWorkspace(ws, filter) {
  const { err, stdout, stderr } = await run(
    './scripts/agent-test.sh',
    filter ? [ws, filter] : [ws],
    { timeout: 900_000 },
  );
  return { ok: !err, out: `${stdout}\n${stderr}`.trim() };
}

/**
 * Map the touched files onto workspaces and test those. Running everything would
 * take long enough that the job would look hung; running nothing would make the
 * gate above decorative.
 *
 * A red workspace run is not evidence the change broke anything.
 *
 * Measured on this repo on 2026-09-09, on an unmodified tree: the `api`
 * workspace failed 2 runs in 4, with a *different* set of suites failing each
 * time — AuthService, skills, optionalShareFileAuth — and every one of them
 * passing when run on its own. The suite is order- and parallelism-dependent
 * (`maxWorkers: '50%'`, and `test/jestSetup.js` points MONGO_URI at
 * 127.0.0.1:27017, which upstream is dead and on this host is the live stack's
 * mongod, published for this very sidecar). So roughly half of all runs go red
 * for reasons no diff can explain.
 *
 * The old gate read that as "your commits failed the tests" and reverted every
 * commit in range. It did exactly that to two jobs — 8 commits and 2 commits —
 * both times on `AuthService.spec.js`, which neither diff came near. A gate that
 * destroys half of all work independently of its quality is not a strict gate,
 * it is a coin flip, and the agent has no way to tell it is being judged by one.
 *
 * So a failure now has to survive isolation before it counts. Each suite that
 * failed in the parallel run is re-run on its own; a suite that passes alone was
 * failing for a reason the change does not own. Only suites that fail *both*
 * ways revert anything — and the flaky ones are named in the record rather than
 * quietly forgiven, because a gate that hides what it waved through is how you
 * get back to trusting nothing.
 */
async function runTests(files) {
  const touched = WORKSPACES.filter((ws) => files.some((f) => f.startsWith(`${ws}/`)));
  if (!touched.length) {
    return { ok: true, text: 'no workspace with tests was touched — nothing to run' };
  }

  const build = await buildTouchedPackages(files);
  if (!build.ok) {
    return { ok: false, text: build.text };
  }

  const results = [];
  const flaky = [];
  if (build.built.length) {
    results.push(`rebuilt before testing: ${build.built.join(', ')}`);
  }
  for (const ws of touched) {
    const first = await testWorkspace(ws);
    if (first.ok) {
      results.push(first.out.split('\n').filter(Boolean).slice(-5).join(' · '));
      continue;
    }

    const suites = failingSuites(first.out);
    if (!suites.length || suites.length > ISOLATION_BUDGET) {
      return {
        ok: false,
        text:
          `\`agent-test.sh ${ws}\` failed` +
          (suites.length
            ? ` in ${suites.length} suites — too many to isolate, so this is being taken at face value`
            : ', and no suite could be named from its output') +
          `:\n\n${first.out.slice(-3000)}`,
      };
    }

    console.log(`[tests] ${ws} red in ${suites.length} suite(s); re-running each alone`);
    const stillFailing = [];
    for (const suite of suites) {
      const solo = await testWorkspace(ws, suite);
      if (!solo.ok) stillFailing.push({ suite, out: solo.out });
      console.log(`[tests] ${ws} ${suite} alone: ${solo.ok ? 'passes — flaky in parallel' : 'fails'}`);
    }

    if (stillFailing.length) {
      return {
        ok: false,
        text:
          `\`agent-test.sh ${ws}\` failed, and ${stillFailing.length} of ${suites.length} ` +
          `suite(s) failed again when run on their own — so this is the change, not the harness:\n\n` +
          stillFailing.map((f) => `### ${f.suite}\n\n${f.out.slice(-1800)}`).join('\n\n'),
      };
    }

    flaky.push(...suites.map((s) => `${ws}/${s}`));
    results.push(
      `PASS ${ws} — after ${suites.length} suite(s) failed in parallel and passed alone: ${suites.join(', ')}`,
    );
  }

  return {
    ok: true,
    text:
      results.join('\n') +
      (flaky.length
        ? `\n\n**Flaky, not caused by this change:** ${flaky.join(', ')} failed in the ` +
          'full parallel run and passed when run alone. Not a reason to hold the deploy, ' +
          'but the suite is unreliable and that is worth someone fixing.'
        : ''),
    flaky,
  };
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
