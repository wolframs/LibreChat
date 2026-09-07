import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { AsyncLocalStorage } from 'async_hooks';
import { handleRequestFix, handleCheckFix, handleListFixes, handleAddNote, handleResumeFix } from './tools.js';
import { activeJobId, MODEL, agentAvailable } from './runner.js';
import { REPO, BRANCH, currentBranch, porcelain, head } from './git.js';
import { mountView } from './view.js';

const app = express();
const mcpContext = new AsyncLocalStorage();

/**
 * No `instructions` declared here, same as the other two sidecars: LibreChat only
 * reads a server's own declared instructions in MCPServerInspector, which skips
 * any server carrying runtime placeholders, and `x-user-id: {{LIBRECHAT_USER_ID}}`
 * is one. The usage guidance lives inline in librechat.yaml.
 */
function createMcpServer() {
  const server = new McpServer({ name: 'code-agent', version: '1.0.0' });

  /**
   * One field, and its description is doing real work.
   *
   * Every additional parameter here is a question the sending model will feel
   * obliged to answer precisely, and precision is exactly what this tool must not
   * demand — the moment filing a premise feels like filling in a form, the sender
   * starts writing specifications instead of observations, and the thing that made
   * this worth building is gone. So: no severity, no scope, no component, no
   * suggested fix. Say what you noticed. The agent works out the rest.
   */
  server.tool(
    'request_fix',
    {
      premise: z
        .string()
        .describe(
          'What you noticed, in your own words. A sentence or two is plenty — "the imager ' +
            'returns an empty result" is a complete and useful filing. Do NOT write a ' +
            'specification, do not diagnose the cause unless you actually know it, and do not ' +
            'suggest an implementation. A Claude Code session reads the whole repository, ' +
            'investigates, and decides what is really wrong; over-specifying makes it worse ' +
            'at that, not better. If your guess about the cause is wrong, saying it confidently ' +
            'sends the agent down your wrong path.',
        ),
    },
    (args) => handleRequestFix(args, mcpContext),
  );

  server.tool(
    'check_fix',
    {
      job_id: z.string().describe('The job id returned by request_fix.'),
      include_diff: z
        .boolean()
        .optional()
        .describe('Return the full diff as well as the summary. Large — ask only if you need it.'),
    },
    (args) => handleCheckFix(args, mcpContext),
  );

  server.tool(
    'resume_fix',
    {
      job_id: z
        .string()
        .describe(
          'A job that stopped at the turn limit. Its Claude Code session is still on disk, ' +
            'so this continues it with everything it had already read and concluded, instead ' +
            'of re-running the same investigation from nothing.',
        ),
    },
    (args) => handleResumeFix(args, mcpContext),
  );

  server.tool(
    'add_note',
    {
      job_id: z.string().describe('The job to add to.'),
      note: z
        .string()
        .describe(
          'Something you realised after filing — a correction, a detail you left out, or ' +
            '"actually the cause is X". If the job is still running the agent is told to ' +
            're-read its notes before committing, so this can still change the outcome. ' +
            'Use it especially when part of your premise turns out to be wrong: it is much ' +
            'cheaper than letting the agent chase it.',
        ),
    },
    (args) => handleAddNote(args, mcpContext),
  );

  server.tool(
    'list_fixes',
    {
      limit: z.number().optional().describe('How many recent jobs to list. Defaults to 10.'),
    },
    (args) => handleListFixes(args, mcpContext),
  );

  return server;
}

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
    const names = (await fs.readdir(SRC_DIR)).filter((n) => n.endsWith('.js') || n.endsWith('.json'));
    const stats = await Promise.all(
      names.map(async (n) => [n, (await fs.stat(path.join(SRC_DIR, n))).mtimeMs]),
    );
    return stats.filter(([, mtime]) => mtime > BOOTED_AT).map(([n]) => n).sort();
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
    ok: true,
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
    ...(stale.length ? { stale } : {}),
  };
}

app.get('/healthz', async (_req, res) => res.json(await healthPayload()));
// Human-facing live view of the same data, proxied to /agent by nginx.
mountView(app, healthPayload);

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const server = createMcpServer();
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
app.listen(PORT, async () => {
  console.log(`MCP code-agent server on port ${PORT}`);
  console.log(`  repo:   ${REPO} (${await currentBranch()} @ ${(await head()).slice(0, 9)})`);
  console.log(`  model:  ${MODEL || '(claude default)'}`);
  console.log(`  uid:    ${process.getuid()} — uses the Claude Code already logged in here`);
  const issue = await agentAvailable();
  if (issue) console.error(`  WARNING: ${issue}`);
});
