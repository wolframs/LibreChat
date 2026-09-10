import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { AsyncLocalStorage } from 'async_hooks';
import {
  activeJobId,
  MODEL,
  agentAvailable,
  initialize,
  shutdown,
  isReady,
  inventory,
} from './runner.js';
import { createMcpServer } from './server.js';
import { closeDb } from './db.js';
import { REPO, BRANCH, currentBranch, porcelain, head } from './git.js';
import { mountView } from './view.js';

const app = express();
const mcpContext = new AsyncLocalStorage();

const transports = new Map();

const BOOTED_AT = Date.now();
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * True when a source file here has been edited since this process started.
 *
 * Node does not reload, and the LaunchAgent's KeepAlive restarts on crash, not on
 * edit — so the ordinary way to work on this server is to change it and then keep
 * talking to the version that was running before the change. That failure is
 * completely silent: the server answers, healthily, with old behaviour.
 *
 * Reported rather than acted on. Restarting itself mid-job would be worse than
 * being stale, and the operator may well be mid-edit on purpose.
 */
async function staleSources() {
  try {
    const names = (await fs.readdir(SRC_DIR)).filter(
      (n) => n.endsWith('.js') || n.endsWith('.json'),
    );
    const stats = await Promise.all(
      names.map(async (n) => [n, (await fs.stat(path.join(SRC_DIR, n))).mtimeMs]),
    );
    return stats
      .filter(([, mtime]) => mtime > BOOTED_AT)
      .map(([n]) => n)
      .sort();
  } catch {
    return [];
  }
}

async function healthPayload() {
  const [branch, dirty, sha, stale] = await Promise.all([
    currentBranch(),
    porcelain(),
    head(),
    staleSources(),
  ]);
  return {
    ok: isReady(),
    model: MODEL || '(claude default)',
    agentAvailable: (await agentAvailable()) == null,
    repo: REPO,
    branch,
    expectedBranch: BRANCH,
    clean: dirty === '',
    head: sha.slice(0, 9),
    activeJob: activeJobId(),
    uid: process.getuid(),
    dailyLimit: parseInt(process.env.CODE_AGENT_DAILY_LIMIT ?? '0', 10) || 'none',
    sessions: transports.size,
    startedAt: new Date(BOOTED_AT).toISOString(),
    worktrees: await inventory(),
    workflow: 'isolated-v2',
    ...(stale.length ? { stale } : {}),
  };
}

app.get('/healthz', async (_req, res) => res.json(await healthPayload()));
// Human-facing live view of the same data, proxied to /agent by nginx.
mountView(app, healthPayload);

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const server = createMcpServer(mcpContext);
  transports.set(transport.sessionId, transport);
  req.on('close', () => transports.delete(transport.sessionId));
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  // Only the user id. A `{{LIBRECHAT_BODY_CONVERSATIONID}}` header would be the
  // obvious way to know which chat this came from, and it makes the server
  // impossible to switch on: a BODY placeholder makes the connection require a
  // chat request body, and enabling a server from the MCP dropdown is a
  // reinitialize with no body — a hard -32600 and a "failed to initialize MCP
  // server" popup. The conversation is found from the user instead (runner.js).
  const store = { userId: req.headers['x-user-id'] };
  mcpContext.run(store, async () => {
    const transport = transports.get(req.query.sessionId);
    if (transport) await transport.handlePostMessage(req, res);
    else res.status(400).send('Session not found');
  });
});

const PORT = process.env.PORT || 3015;
await initialize();
const httpServer = app.listen(PORT, async () => {
  console.log(`MCP code-agent server on port ${PORT}`);
  console.log(`  repo:   ${REPO} (${await currentBranch()} @ ${(await head()).slice(0, 9)})`);
  console.log(`  model:  ${MODEL || '(claude default)'}`);
  console.log(`  uid:    ${process.getuid()} — uses the Claude Code already logged in here`);
  const issue = await agentAvailable();
  if (issue) console.error(`  WARNING: ${issue}`);
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    httpServer.close();
    await shutdown();
    await closeDb();
    process.exit(0);
  });
