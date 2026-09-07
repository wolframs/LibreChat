import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { AsyncLocalStorage } from 'async_hooks';
import { handleRequestFix, handleCheckFix, handleListFixes } from './tools.js';
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
    'list_fixes',
    {
      limit: z.number().optional().describe('How many recent jobs to list. Defaults to 10.'),
    },
    (args) => handleListFixes(args, mcpContext),
  );

  return server;
}

const transports = new Map();

async function healthPayload() {
  const [branch, dirty, sha] = await Promise.all([currentBranch(), porcelain(), head()]);
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
    dailyLimit: parseInt(process.env.CODE_AGENT_DAILY_LIMIT ?? '3', 10),
    sessions: transports.size,
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
