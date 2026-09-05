import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { AsyncLocalStorage } from 'async_hooks';
import { handleGenerateImage, handleGetUserImages, MODEL, ASPECT_RATIOS } from './tools.js';

const app = express();
const mcpContext = new AsyncLocalStorage();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/LibreChat';

/**
 * No `instructions` are declared here on purpose, and this is worth knowing before
 * "fixing" it: LibreChat only reads a server's declared instructions in
 * MCPServerInspector, which skips any server carrying runtime placeholders — the
 * `x-user-id: {{LIBRECHAT_USER_ID}}` header this one needs is exactly that. Whatever
 * we declared here would be fetched by nobody, while `serverInstructions: true` in
 * librechat.yaml stays the literal boolean and gets injected into the system prompt
 * as the word "true".
 *
 * So the usage guidance lives inline in librechat.yaml under
 * `mcpServers.openrouter-imager.serverInstructions`, as the single copy. The
 * per-argument facts stay in the tool descriptions below, where they always reach
 * the model.
 */
function createMcpServer() {
  const server = new McpServer({ name: 'openrouter-imager', version: '1.0.0' });

  server.tool(
    'get_user_images',
    {
      limit: z.number().optional().describe('Max number of recent images to return. Defaults to 10.'),
    },
    (args) => handleGetUserImages(args, mcpContext),
  );

  server.tool(
    'generate_image',
    {
      prompt: z.string().describe('Text prompt describing the image to generate.'),
      reference_image_url: z
        .string()
        .optional()
        .describe(
          "The local database file_id OR index number (e.g. '1', '2' or 'INDEX_1', 'INDEX_2') of a reference image to use. Provider file ids (file-xxxx) are NOT supported. Call get_user_images first to list available images and get their local file_ids or index numbers.",
        ),
      reference_image_urls: z
        .array(z.string())
        .optional()
        .describe(
          'A list of local database file_ids OR index numbers of reference images to combine or use. Provider file ids (file-xxxx) are NOT supported. Call get_user_images first.',
        ),
      aspect_ratio: z
        .enum(ASPECT_RATIOS)
        .optional()
        .describe(
          "Output dimensions only — never affects content or style. meta/muse-image honours orientation rather than the exact ratio: any landscape value returns 3:2, any portrait value returns 2:3, '1:1' returns square. Use '1:1' square, '16:9' landscape, '9:16' vertical, '4:5' portrait.",
        ),
    },
    (args) => handleGenerateImage(args, mcpContext),
  );

  return server;
}

const transports = new Map();

// Probed by scripts/deploy.sh, alongside the /cost and /export sidecar checks.
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    hasKey: Boolean(process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY),
    dailyLimit: parseInt(process.env.IMAGE_GEN_DAILY_LIMIT ?? '3', 10),
    cooldownSec: parseInt(process.env.IMAGE_GEN_COOLDOWN_SEC ?? '30', 10),
    sessions: transports.size,
  });
});

app.get('/sse', async (req, res) => {
  console.log('New SSE connection. Query:', req.query, 'Headers:', req.headers);
  const transport = new SSEServerTransport('/messages', res);
  const server = createMcpServer();
  transports.set(transport.sessionId, transport);
  req.on('close', () => {
    console.log(`SSE closed: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  });
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const conversationId = req.headers['x-conversation-id'];
  mcpContext.run({ userId, conversationId }, async () => {
    const transport = transports.get(req.query.sessionId);
    if (transport) await transport.handlePostMessage(req, res);
    else res.status(400).send('Session not found');
  });
});

const PORT = process.env.PORT || 3013;
app.listen(PORT, () => {
  console.log(`MCP Image Generation server on port ${PORT}`);
  console.log(`  model:     ${MODEL}`);
  console.log(`  MONGO_URI: ${MONGO_URI}`);
});
