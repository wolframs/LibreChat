import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { AsyncLocalStorage } from 'async_hooks';
import {
  handleGenerateImage,
  handleGetUserImages,
  ASPECT_RATIOS,
  openRouterKey,
  surplusKey,
  surplusSpendLast7Days,
  SURPLUS_WEEKLY_CAP_USD,
  routingState,
} from './tools.js';
import { MODELS, MODEL_IDS, DEFAULT_MODEL, loadCatalogue, describeModels } from './models.js';
import { SURPLUS_BASE } from './surplus.js';

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
 * `mcpServers.imager.serverInstructions`, as the single copy. The per-argument
 * facts stay in the tool descriptions below, where they always reach the model —
 * including the model list, which is built from the registry at startup so the
 * options the model sees are exactly the ones the server will accept.
 */
function createMcpServer() {
  const server = new McpServer({ name: 'imager', version: '2.0.0' });

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
      model: z.enum(MODEL_IDS).optional().describe(describeModels()),
      reference_image_url: z
        .string()
        .optional()
        .describe(
          "The local database file_id OR index number (e.g. '1', '2' or 'INDEX_1', 'INDEX_2') of a reference image to use. Provider file ids (file-xxxx) are NOT supported. Call get_user_images_mcp_imager first to list available images and get their local file_ids or index numbers. Only models whose description says image-to-image accept this.",
        ),
      reference_image_urls: z
        .array(z.string())
        .optional()
        .describe(
          'A list of local database file_ids OR index numbers of reference images to combine or use. Provider file ids (file-xxxx) are NOT supported. Call get_user_images_mcp_imager first. Only models whose description says image-to-image accept this.',
        ),
      aspect_ratio: z
        .enum(ASPECT_RATIOS)
        .optional()
        .describe(
          "Output dimensions only — never affects content or style. Every model here honours orientation rather than the exact ratio: any landscape value returns a landscape image (3:2 on meta/muse-image; 3:2 or 7:4 on Surplus models), any portrait value a portrait one, '1:1' a square. Use '1:1' square, '16:9' landscape, '9:16' vertical, '4:5' portrait.",
        ),
    },
    (args) => handleGenerateImage(args, mcpContext),
  );

  return server;
}

const transports = new Map();

/** What `--check` needs to know: which models are configured, and which of them cannot run. */
async function healthReport() {
  const keys = { openrouter: Boolean(openRouterKey()), surplus: Boolean(surplusKey()) };
  const warnings = [];
  const unusable = MODELS.filter((m) => !keys[m.provider]).map((m) => m.id);
  if (unusable.length > 0) {
    warnings.push(
      `no key for ${unusable.join(', ')} — set ${unusable.some((id) => !id.includes('/')) ? 'SURPLUS_IMAGE_KEY' : 'OPENROUTER_KEY'}`,
    );
  }
  // The weekly cap and where it stands, so `--check` shows a cap about to bite.
  let surplusWeek = null;
  if (MODELS.some((m) => m.provider === 'surplus')) {
    try {
      const { usd, n } = await surplusSpendLast7Days();
      surplusWeek = { capUsd: SURPLUS_WEEKLY_CAP_USD, spentUsd: Number(usd.toFixed(4)), images: n };
      if (SURPLUS_WEEKLY_CAP_USD > 0 && usd >= SURPLUS_WEEKLY_CAP_USD) {
        warnings.push(`Surplus weekly cap reached ($${usd.toFixed(4)} of $${SURPLUS_WEEKLY_CAP_USD})`);
      }
    } catch (err) {
      warnings.push(`could not read Surplus spend from Mongo: ${err.message}`);
    }
  }
  return {
    ok: true,
    defaultModel: DEFAULT_MODEL,
    models: MODELS.map((m) => `${m.id}@${m.provider}`),
    keys,
    // Kept for the older deploy.sh probe, which looks for `"hasKey":false`.
    hasKey: keys.openrouter || keys.surplus,
    surplusWeek,
    // Models Surplus answered "not routing" for in the last few minutes. A
    // liquidity gap, not a fault; shown so a --check right after a failed chat
    // has the answer without a log dive.
    surplusNotRouting: routingState(),
    warnings,
    dailyLimit: parseInt(process.env.IMAGE_GEN_DAILY_LIMIT ?? '3', 10),
    cooldownSec: parseInt(process.env.IMAGE_GEN_COOLDOWN_SEC ?? '30', 10),
    sessions: transports.size,
  };
}

// Probed by scripts/deploy.sh, alongside the /cost and /export sidecar checks.
app.get('/healthz', async (_req, res) => {
  res.json(await healthReport());
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

// Prices and edit-capability come from the Surplus catalogue and are baked into
// the tool description, so fetch them once before the first session can connect.
// A failed fetch is a warning, not a refusal: built-in prices cover the defaults.
const catalogue = await loadCatalogue({ surplusKey: surplusKey(), surplusBase: SURPLUS_BASE });

app.listen(PORT, () => {
  console.log(`MCP Image Generation server (imager) on port ${PORT}`);
  console.log(`  default:   ${DEFAULT_MODEL}`);
  for (const m of MODELS) {
    console.log(`  model:     ${m.id} via ${m.provider}${m.price != null ? ` ($${m.price}/${m.unit})` : ''}`);
  }
  console.log(`  catalogue: ${catalogue.fetched ? `fetched (${catalogue.matched} matched)` : `not fetched${catalogue.error ? ` — ${catalogue.error}` : ''}`}`);
  console.log(`  MONGO_URI: ${MONGO_URI}`);
  console.log(`  surplus cap: $${SURPLUS_WEEKLY_CAP_USD}/7d`);
  healthReport().then((h) => {
    for (const w of h.warnings) console.warn(`  WARNING:   ${w}`);
  });
});
