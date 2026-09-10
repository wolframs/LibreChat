import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { getDb } from './db.js';
import { REPO, BRANCH, run } from './git.js';
import { Worktrees, gitAt } from './worktrees.js';
import { Engine } from './engine.js';
import { Deployment } from './deployment.js';
import { prepareDependencies, runTests } from './validation.js';
import { acquireLock } from './lock.js';

export const MODEL = process.env.CODE_AGENT_MODEL || '';
const number = (name, fallback, min = 1) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}.`);
  return value;
};
const worktrees = new Worktrees(REPO, BRANCH, process.env.CODE_AGENT_WORKTREE_ROOT);
let ready = false;
let releaseLock;
let shuttingDown = false;

async function update(id, record) {
  const db = await getDb();
  const fields = { ...record };
  delete fields._id;
  for (const key of ['createdAt', 'updatedAt', 'finishedAt', 'resumedAt']) {
    if (fields[key]) fields[key] = new Date(fields[key]);
  }
  await db
    .collection('mcp_code_agent_jobs')
    .updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...fields, updatedAt: new Date() } },
      { upsert: true },
    );
}

async function context(userId) {
  if (!userId) return {};
  try {
    const db = await getDb();
    const conversation = await db.collection('conversations').findOne(
      { user: userId },
      {
        sort: { updatedAt: -1 },
        projection: { conversationId: 1, endpoint: 1, model: 1, updatedAt: 1 },
      },
    );
    const maxAge = number('CODE_AGENT_CONTEXT_MAX_AGE_MIN', 30);
    if (!conversation || Date.now() - new Date(conversation.updatedAt).getTime() > maxAge * 60000)
      return {};
    const rows = await db
      .collection('messages')
      .find({ conversationId: conversation.conversationId })
      .project({ text: 1, sender: 1, isCreatedByUser: 1 })
      .sort({ createdAt: -1 })
      .limit(number('CODE_AGENT_CONTEXT_MESSAGES', 12))
      .toArray();
    return {
      sender: [conversation.endpoint, conversation.model].filter(Boolean).join(' / '),
      conversation: rows
        .reverse()
        .filter((m) => m.text)
        .map((m) => ({
          who: m.isCreatedByUser ? 'user' : m.sender || 'assistant',
          text: m.text.slice(0, 4000),
        })),
    };
  } catch (err) {
    console.warn(`Conversation context unavailable: ${err.message}`);
    return {};
  }
}

export const engine = new Engine({
  worktrees,
  update,
  context,
  prepare: prepareDependencies,
  test: runTests,
  deployment: new Deployment(REPO, worktrees),
  model: MODEL,
  maxTurns: number('CODE_AGENT_MAX_TURNS', 250),
  maxContinuations: number('CODE_AGENT_MAX_CONTINUATIONS', 2, 0),
  timeoutMs: number('CODE_AGENT_TIMEOUT_SEC', 2700) * 1000,
  maxWorktrees: number('CODE_AGENT_MAX_WORKTREES', 12),
  settings: path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-settings.json'),
});

export async function initialize() {
  const common = await gitAt(REPO, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  releaseLock = await acquireLock(path.join(common, 'code-agent'));
  try {
    await getDb();
    const count = await engine.recover();
    // Old jobs used the shared checkout. Never resume that session in a different cwd.
    const db = await getDb();
    await db.collection('mcp_code_agent_jobs').updateMany(
      {
        worktree: { $exists: false },
        status: { $in: ['running', 'testing', 'deploying'] },
      },
      {
        $set: {
          status: 'recovery_required',
          stoppedBecause: 'legacy_shared_checkout',
          summary:
            'This legacy job ran in the operator checkout. Inspect its commits and any remaining process before filing new work; it cannot be resumed under the isolated workflow.',
        },
      },
    );
    ready = true;
    return count;
  } catch (err) {
    await releaseLock();
    releaseLock = null;
    throw err;
  }
}

export async function shutdown() {
  shuttingDown = true;
  ready = false;
  if (engine.active) {
    await engine.pause(engine.active).catch(() => {});
    await engine.task;
  }
  if (releaseLock) await releaseLock();
}

export function activeJobId() {
  return engine.active;
}
export function isReady() {
  return ready && !shuttingDown;
}
export async function inventory() {
  return worktrees.inventory();
}

export async function agentAvailable() {
  const { err } = await run('claude', ['--version'], { timeout: 20_000 });
  return err ? `The claude CLI cannot run: ${err.message}` : null;
}

export async function preflight() {
  if (!isReady())
    return {
      ok: false,
      reason: 'Supervisor is starting or shutting down. Check health before retrying.',
    };
  if (engine.active) return { ok: false, reason: `Job ${engine.active} is active.` };
  const issue = await agentAvailable();
  return issue ? { ok: false, reason: issue } : { ok: true };
}

export async function startJob({ premise, userId }) {
  const id = new ObjectId().toString();
  await engine.start(id, premise, userId);
  return id;
}

export async function getJob(id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  const db = await getDb();
  return db.collection('mcp_code_agent_jobs').findOne({ _id: new ObjectId(id) });
}

export async function listJobs(userId, limit = 10) {
  const db = await getDb();
  return db
    .collection('mcp_code_agent_jobs')
    .find(userId ? { userId } : {})
    .sort({ createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Math.trunc(limit) || 10)))
    .toArray();
}

export async function resumeJob(id) {
  const pre = await preflight();
  if (!pre.ok) return pre;
  try {
    await engine.resume(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
export const appendNote = (id, note, from) => engine.note(id, note, from);
export const pauseJob = (id) => engine.pause(id);
export const archiveJob = (id) => engine.archive(id);
export { REPO };
