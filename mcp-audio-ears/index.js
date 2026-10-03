import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { AsyncLocalStorage } from 'async_hooks';
import { handleListenToAudio, handleGetUserAudio, MODEL, WEEKLY_BUDGET_USD } from './tools.js';

const app = express();
const mcpContext = new AsyncLocalStorage();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/LibreChat';

/**
 * No `instructions` are declared here, for the same reason as mcp-image-gen:
 * LibreChat only reads a server's declared instructions in MCPServerInspector,
 * which skips any server carrying runtime placeholders — and the
 * `x-user-id: {{LIBRECHAT_USER_ID}}` header this one needs is exactly that.
 * `serverInstructions: true` would inject the literal word "true" into the system
 * prompt. So the usage guidance lives inline in librechat.yaml under
 * `mcpServers.audio-ears.serverInstructions`, and the per-argument facts live in
 * the tool descriptions below, which always reach the model.
 */
function createMcpServer() {
  const server = new McpServer({ name: 'audio-ears', version: '1.0.0' });

  server.tool(
    'get_user_audio',
    {
      limit: z
        .number()
        .optional()
        .describe('Max number of recent audio files to return. Defaults to 10.'),
    },
    (args) => handleGetUserAudio(args, mcpContext),
  );

  server.tool(
    'listen_to_audio',
    {
      file_id: z
        .string()
        .describe(
          "The file_id of an audio file this user uploaded, or its index from get_user_audio ('1', 'INDEX_1'). Call get_user_audio first if you do not have one.",
        ),
      focus: z
        .string()
        .optional()
        .describe(
          "What to pay attention to, appended to the description prompt. E.g. 'Focus on the bassline and the drum programming', or 'Transcribe the spoken content verbatim'.",
        ),
      style: z
        .enum(['feel', 'analyze'])
        .optional()
        .describe(
          "'feel' (default) returns evocative prose about how the audio sounds — best when discussing music with the user. 'analyze' returns a scannable breakdown: time-stamped sections, element inventory, explicit transcription.",
        ),
      max_seconds: z
        .number()
        .optional()
        .describe('Only listen to the first N seconds. Use to sample a long file cheaply.'),
      shrink: z
        .boolean()
        .optional()
        .describe(
          'Re-encode to 64kbps mono before sending. ~3.5x smaller and faster; genre, instrumentation, structure and lyric fragments all survive it. Use on anything long.',
        ),
      cross_check: z
        .boolean()
        .optional()
        .describe(
          'Also describe with a second model and return both. Doubles the cost. Worth it when the track has a strong stylistic premise you want verified, since these models confabulate genre from opening seconds.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          `OpenRouter model id, if you need to override the server default (${MODEL}). Must genuinely accept audio input — a model that merely lists "audio" in its modalities may discard it silently.`,
        ),
    },
    (args) => handleListenToAudio(args, mcpContext),
  );

  return server;
}

const transports = new Map();

function requestUserId(req) {
  const value = req.headers['x-user-id'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Probed by scripts/deploy.sh, alongside the /cost, /export and image-gen checks.
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    hasKey: Boolean(process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY),
    weeklyBudgetUSD: WEEKLY_BUDGET_USD,
    sessions: transports.size,
  });
});

// A byte every 30 s: LibreChat applies the yaml row's `timeout` as undici's
// bodyTimeout on the SSE stream, and an idle session sends nothing, so without
// this the api kills and reopens the stream on that cadence and a tool call in
// the reconnect window fails with "not found". Same fix as mcp-image-gen.
const SSE_KEEPALIVE_MS = parseInt(process.env.SSE_KEEPALIVE_MS ?? '30000', 10);

app.get('/sse', async (req, res) => {
  const userId = requestUserId(req);
  if (!userId) {
    return res.status(401).send('Authenticated user context is required');
  }
  console.log('New authenticated SSE connection. Query:', req.query);
  const transport = new SSEServerTransport('/messages', res);
  const server = createMcpServer();
  transports.set(transport.sessionId, { transport, userId });
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, SSE_KEEPALIVE_MS);
  req.on('close', () => {
    console.log(`SSE closed: ${transport.sessionId}`);
    clearInterval(keepalive);
    transports.delete(transport.sessionId);
  });
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const userId = requestUserId(req);
  if (!userId) {
    return res.status(401).send('Authenticated user context is required');
  }
  const session = transports.get(req.query.sessionId);
  if (!session || session.userId !== userId) {
    return res.status(403).send('Session does not belong to this user');
  }
  const conversationId = req.headers['x-conversation-id'];
  mcpContext.run({ userId, conversationId }, async () => {
    await session.transport.handlePostMessage(req, res);
  });
});

const PORT = process.env.PORT || 3014;
app.listen(PORT, () => {
  console.log(`MCP audio-ears server on port ${PORT}`);
  console.log(`  model:     ${MODEL}`);
  console.log(`  MONGO_URI: ${MONGO_URI}`);
});
