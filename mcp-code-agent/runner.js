import { ObjectId } from 'mongodb';
import { getDb } from './db.js';
import { buildPrompt } from './prompt.js';
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

export const MODEL = process.env.CODE_AGENT_MODEL || 'opus';
const MAX_TURNS = parseInt(process.env.CODE_AGENT_MAX_TURNS ?? '80', 10);
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

function claudeArgs(prompt) {
  return [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--model',
    MODEL,
    '--max-turns',
    String(MAX_TURNS),
    // Deny rules only — the short list of things `git revert` cannot undo.
    '--settings',
    '/app/agent-settings.json',
    // No human is present to answer a permission prompt, so there is no useful
    // interactive mode here. Safety is the container, not the dialog: the agent
    // reaches this repository and nothing else, and everything it does is a
    // commit that `git revert` undoes.
    '--dangerously-skip-permissions',
  ];
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

async function execute(jobId, { premise, userId }) {
  const baseSha = await head();
  await setJob(jobId, { baseSha });

  const active = await activeConversation(userId);
  const sender = active?.sender ?? null;
  const conversation = await conversationContext(active?.conversationId);
  await setJob(jobId, { sender, conversationId: active?.conversationId ?? null });
  const prompt = buildPrompt({ premise, sender, conversation });

  console.log(`[${jobId}] running ${MODEL} from ${baseSha.slice(0, 9)}`);
  const started = Date.now();
  const { err, stdout, stderr } = await run('claude', claudeArgs(prompt), {
    timeout: AGENT_TIMEOUT_MS,
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '' },
  });
  const elapsed = Math.round((Date.now() - started) / 1000);

  let report = '';
  let cost = null;
  try {
    const parsed = JSON.parse(stdout);
    report = parsed.result || '';
    cost = parsed.total_cost_usd ?? null;
  } catch {
    report = stdout.trim();
  }

  if (err && !report) {
    await finish(jobId, {
      status: 'error',
      summary:
        `The agent did not finish (${err.killed ? `timed out after ${AGENT_TIMEOUT_MS / 1000}s` : err.message}).` +
        `\n\n${(stderr || '').trim().slice(-1500)}`,
      cost,
      elapsed,
    });
    return;
  }

  const commits = await commitsSince(baseSha);

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
    });
    await writeEntry(entry, jobId);
    await finish(jobId, { status: 'no_change', summary: report, cost, elapsed, commits: [] });
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
    });
    await writeEntry(entry, jobId);
    await finish(jobId, {
      status: reverted.err ? 'broken' : 'tests_failed',
      summary:
        `${report}\n\nThe wrapper re-ran the tests before deploying and they failed, so ` +
        `nothing was deployed${reverted.err ? ' AND THE REVERT FAILED — the stack needs a human' : ' and the commits were reverted'}.\n\n${tests.text}`,
      cost,
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
    report: report + rollbackNote,
    commits,
    diffstat: stat,
    tests: 'run by the agent; see its report',
    deploy: deployResult.text,
  });
  await writeEntry(entry, jobId);

  await finish(jobId, {
    status,
    summary: report + rollbackNote,
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
