import { ObjectId } from 'mongodb';
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { fetchImageById, extractFileId } from './files.js';
import { generateImageOnOpenRouter, referencesToDataUrls } from './openrouter.js';
import { generateImageOnSurplus, SurplusNotRoutingError } from './surplus.js';
import { DEFAULT_MODEL, MODELS, findModel, canEdit } from './models.js';

/**
 * The names LibreChat registers these tools under. It appends `_mcp_<server key>`
 * — the key of this server in librechat.yaml's `mcpServers`, which is `imager` —
 * and a model that reads a bare `generate_image` in the instructions and calls
 * that gets `Tool "generate_image" not found` and burns a turn. Every piece of
 * text a model reads, here and in the yaml, uses the full name.
 */
export const TOOL_SUFFIX = '_mcp_imager';
export const GENERATE_TOOL = `generate_image${TOOL_SUFFIX}`;
export const LIST_TOOL = `get_user_images${TOOL_SUFFIX}`;

/**
 * Models Surplus has answered "not routing" for recently, with when that was.
 *
 * A second call inside the window is refused here, before the round-trip, with
 * the same message — a model that has just been told to switch and tries once
 * more anyway (the 2026-09-08 duel did) should not wait on the gateway to say
 * it again. The window is short because liquidity really does come back within
 * minutes; this is loop protection, not a health model.
 */
export const NOT_ROUTING_WINDOW_MS = parseInt(process.env.IMAGE_GEN_NOT_ROUTING_WINDOW_MS ?? String(3 * 60 * 1000), 10);
const notRouting = new Map();

export function markNotRouting(modelId, now = Date.now()) {
  notRouting.set(modelId, now);
}

export function notRoutingSince(modelId, now = Date.now()) {
  const at = notRouting.get(modelId);
  if (at == null) return null;
  if (now - at > NOT_ROUTING_WINDOW_MS) {
    notRouting.delete(modelId);
    return null;
  }
  return at;
}

export function routingState(now = Date.now()) {
  const out = {};
  for (const [id, at] of notRouting) {
    if (now - at <= NOT_ROUTING_WINDOW_MS) out[id] = new Date(at).toISOString();
  }
  return out;
}

/** The message a model reads when a Surplus model has no seller: what, why, and what else. */
export function notRoutingMessage(model, { needsEdit, now = Date.now() }) {
  const since = notRoutingSince(model.id, now);
  const alternatives = MODELS.filter(
    (m) => m.id !== model.id && (!needsEdit || canEdit(m)) && notRoutingSince(m.id, now) == null,
  ).map((m) => `'${m.id}'${m.provider === 'openrouter' ? ' (OpenRouter, always routable)' : ''}`);
  const retryIn = since ? Math.max(1, Math.ceil((NOT_ROUTING_WINDOW_MS - (now - since)) / 60000)) : null;
  return (
    `Surplus Intelligence is not routing ${model.id} right now: the marketplace lists it but no ` +
    'seller is serving it at this moment. This is a liquidity gap, not a problem with your request — ' +
    'the same call works when a seller is back, often within minutes. Nothing was billed. ' +
    `Do not retry ${model.id}${retryIn ? ` for the next ${retryIn} minute(s)` : ''}; ` +
    (alternatives.length > 0
      ? `switching to another model is the right move here — ${alternatives.join(', ')}` +
        `${needsEdit ? ' can take reference images' : ''}. Tell the user which model actually ran.`
      : 'no other configured model can do this right now — tell the user and stop.')
  );
}
import {
  imageDimensions,
  nearestRatio,
  orientationOf,
  formatBytes,
  ratioValue,
  ratiosMatch,
} from './imageinfo.js';

export const MODEL = DEFAULT_MODEL;

export function openRouterKey() {
  return process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '';
}

/**
 * A Surplus key of its own, not `SURPLUS_API_KEY`. That one is the cost
 * dashboard's and predates the images endpoints: a key minted before
 * they existed answers `/v1/images/*` with 403 `endpoint_not_in_key_scope`,
 * and nothing about a key says which endpoints it can call — `/v1/buyer/keys`
 * lists no scope field. A key minted 2026-09-08 could call them at once. So a
 * fresh key, labelled `librechat-imager` in the Surplus dashboard, and the
 * `--check` probe reports when it is missing.
 */
export function surplusKey() {
  return process.env.SURPLUS_IMAGE_KEY || '';
}

/**
 * OpenRouter validates aspect_ratio against this closed set and rejects anything
 * else with a 400, so `index.js` makes it a z.enum rather than a free string — a
 * model that invents "1080x1920" should fail at the tool boundary with a readable
 * message instead of burning a round-trip on a gateway error. It lives here rather
 * than in index.js because the result summary matches the delivered dimensions
 * against the same set.
 */
export const ASPECT_RATIOS = [
  '1:1',
  '1:2',
  '1:4',
  '1:8',
  '2:1',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '9:19.5',
  '19.5:9',
  '9:20',
  '20:9',
  '9:21',
  '21:9',
  'auto',
];

/**
 * Ceiling on the base64 payload we will hand back as an MCP `image` block.
 *
 * LibreChat refuses an image result above `MCP_IMAGE_DATA_MAX_BYTES` (default
 * 10 MB), so anything over that is bytes pushed through the SSE transport for a
 * preview nobody will ever see. Checking here costs the inline preview and
 * nothing else: the text summary still lands, and it can say why in this
 * server's own words. Keep this at or below the api container's value.
 *
 * It used to matter more. Until 2026-09-07 the api-side cap *threw*, and the
 * throw took the whole tool result with it — text block included — so an
 * oversized image left the model with `tool call failed` for a generation it had
 * already paid for. `packages/api/src/mcp/parsers.ts` now drops just the
 * offending block and keeps the rest, so this guard is belt to that braces.
 */
const MAX_INLINE_IMAGE_BYTES = parseInt(
  process.env.IMAGE_GEN_MAX_INLINE_BYTES ?? String(10 * 1024 * 1024),
  10,
);

export async function handleGetUserImages({ limit }, context) {
  try {
    const store = context.getStore();
    const userId = store?.userId;
    console.log(`handleGetUserImages query details: userId=${userId}`);

    const db = await getDb();
    const query = { type: { $regex: /^image\// } };

    if (userId) {
      query.user = new ObjectId(userId);
    }

    const images = await db
      .collection('files')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit || 10)
      .toArray();

    if (!images || images.length === 0) {
      return {
        content: [{ type: 'text', text: 'No uploaded images found. Please upload an image first.' }],
      };
    }

    const list = images
      .map((img, i) => `${i + 1}. [INDEX_${i + 1}] file_id: "${img.file_id}" — ${img.filename}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${images.length} uploaded image(s):\n${list}\n\nUse EITHER the file_id OR the index number (e.g., '1', '2' or 'INDEX_1', 'INDEX_2') as the reference_image_url/reference_image_urls when calling ${GENERATE_TOOL}.`,
        },
      ],
    };
  } catch (err) {
    console.error('Error in get_user_images:', err.message);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error fetching images from DB: ${err.message}` }],
    };
  }
}

async function resolveImageIds(inputs, userId) {
  if (!inputs || inputs.length === 0) return [];

  const db = await getDb();
  const resolvedIds = [];
  let userImagesCache = null;

  async function getUserImages() {
    if (userImagesCache) return userImagesCache;
    if (!userId) return [];
    try {
      userImagesCache = await db
        .collection('files')
        .find({ user: new ObjectId(userId), type: { $regex: /^image\// } })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();
      return userImagesCache;
    } catch (err) {
      console.error('Failed to query user images for resolution:', err.message);
      return [];
    }
  }

  for (const input of inputs) {
    if (!input) continue;

    // Short index alias, e.g. "1", "2", "INDEX_1" — as handed out by get_user_images.
    const indexMatch = input.trim().toUpperCase().match(/^(INDEX_)?(\d+)$/);

    if (indexMatch) {
      const idx = parseInt(indexMatch[2], 10) - 1;
      const images = await getUserImages();
      if (images && images[idx]) {
        console.log(`Resolved index "${input}" -> file_id "${images[idx].file_id}"`);
        resolvedIds.push(images[idx].file_id);
      } else {
        console.warn(`Could not resolve index "${input}" — out of bounds or no images found.`);
        resolvedIds.push(input);
      }
    } else {
      resolvedIds.push(input);
    }
  }
  return resolvedIds;
}

/**
 * Per-user spend guard. The key is server-wide, so without this any account on the
 * stack could run up the bill on it; the limit, not the key, is the control.
 * "Daily" resets at container-local midnight (UTC unless TZ is set on the service).
 */
async function checkImageGenerationLimit(userId) {
  if (!userId) {
    console.warn('No userId provided for usage limiting. Allowing generation.');
    return { allowed: true };
  }

  const db = await getDb();
  const dailyLimit = parseInt(process.env.IMAGE_GEN_DAILY_LIMIT ?? '3', 10);
  const cooldownSec = parseInt(process.env.IMAGE_GEN_COOLDOWN_SEC ?? '30', 10);

  const now = new Date();
  const userObjectId = new ObjectId(userId);

  if (cooldownSec > 0) {
    const lastUsage = await db
      .collection('mcp_image_gen_usage')
      .findOne({ userId: userObjectId }, { sort: { createdAt: -1 } });

    if (lastUsage) {
      const elapsedSec = Math.floor((now.getTime() - lastUsage.createdAt.getTime()) / 1000);
      if (elapsedSec < cooldownSec) {
        return {
          allowed: false,
          reason: `Please wait ${cooldownSec - elapsedSec} second(s) before generating another image.`,
        };
      }
    }
  }

  if (dailyLimit > 0) {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const count = await db
      .collection('mcp_image_gen_usage')
      .countDocuments({ userId: userObjectId, createdAt: { $gte: startOfDay } });

    if (count >= dailyLimit) {
      return {
        allowed: false,
        reason: `You have reached your daily limit of ${dailyLimit} images. Please try again tomorrow.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Rolling seven-day dollar cap on Surplus-routed spend, across all users.
 *
 * This exists because the marketplace cannot do it: `PUT /v1/buyer/keys/{id}/
 * preferences` takes a `limits` object the docs call "reserved for future spend
 * caps; send {}", and on 2026-09-08 it answered `{"weekly_usd":1.5}` with 200 and
 * stored `{}`. The key spends the whole credit balance until then. So the cap the
 * operator wanted on the key is enforced here, on the key's only consumer.
 *
 * Spend is summed the same way the docs sum it: the settled figure where the
 * reconciler has written one, the provider's own figure where the response
 * carried one, list price otherwise. List is ~3× settled on Surplus, so an
 * unreconciled hour counts conservatively and the cap is never overshot by it.
 * The check is made against the *list* price of the call about to be made.
 */
export const SURPLUS_WEEKLY_CAP_USD = parseFloat(process.env.IMAGE_GEN_SURPLUS_WEEKLY_USD ?? '1.5');

const SPEND_EXPR = { $ifNull: ['$reconciled.costUSD', { $ifNull: ['$cost', { $ifNull: ['$listCost', 0] }] }] };

export async function surplusSpendLast7Days() {
  const db = await getDb();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [row] = await db
    .collection('mcp_image_gen_usage')
    .aggregate([
      { $match: { provider: 'surplus', createdAt: { $gte: since } } },
      { $group: { _id: null, usd: { $sum: SPEND_EXPR }, n: { $sum: 1 } } },
    ])
    .toArray();
  return { usd: row?.usd ?? 0, n: row?.n ?? 0, since };
}

async function checkSurplusWeeklyCap(model) {
  if (model.provider !== 'surplus' || !(SURPLUS_WEEKLY_CAP_USD > 0)) return { allowed: true };
  const { usd, n } = await surplusSpendLast7Days();
  const next = model.price ?? 0;
  if (usd + next > SURPLUS_WEEKLY_CAP_USD) {
    return {
      allowed: false,
      reason:
        `Surplus image spend is at $${usd.toFixed(4)} over the last 7 days (${n} images) against a ` +
        `$${SURPLUS_WEEKLY_CAP_USD} weekly cap, so ${model.id} cannot run right now. ` +
        'The OpenRouter model(s) are not capped this way — use one of those, or wait.',
    };
  }
  return { allowed: true };
}

/**
 * One row per generation. `cost` is OpenRouter's own settled figure for the call,
 * kept because this spend never reaches LibreChat's `transactions` collection —
 * this collection is the only record of it, and it is what /cost reads
 * (`cost-dashboard/sidecars.py`) for the summary cards and the sidecar panel.
 */
async function logImageGenerationUsage(userId, prompt, model, usage, meta = {}) {
  if (!userId) return;
  try {
    const db = await getDb();
    await db.collection('mcp_image_gen_usage').insertOne({
      userId: new ObjectId(userId),
      createdAt: new Date(),
      prompt,
      model: model.id,
      provider: model.provider,
      // OpenRouter settles in the response; Surplus settles in the hourly usage
      // export. `cost` is the settled figure when one exists, else null, and
      // `listCost` is the catalogue price either way. The reconciler fills
      // `reconciled.costUSD` on Surplus rows later — match on `model` and
      // `requestedAt`, since the export's request_id is not the response header's.
      cost: usage?.cost ?? null,
      costSource: usage?.cost != null ? 'openrouter' : model.price != null ? 'list' : null,
      listCost: model.price ?? null,
      requestId: meta.requestId ?? null,
      requestedAt: meta.requestedAt ?? null,
      adaptedParams: meta.adaptedParams ?? null,
      usage: usage ?? null,
      // `fileId` is the same id the saved `files` row carries, so a usage row can be
      // joined back to the image it paid for.
      file_id: meta.fileId ?? null,
      width: meta.dims?.width ?? null,
      height: meta.dims?.height ?? null,
      bytes: meta.bytes ?? null,
      referencesRequested: meta.referencesRequested ?? null,
      referencesUsed: meta.referencesUsed ?? null,
    });
  } catch (err) {
    console.error('Failed to log image generation usage to DB:', err.message);
  }
}

/**
 * The text block that makes the result legible to the model.
 *
 * Without it the tool returned an `image` block and nothing else, and LibreChat
 * diverts every image block into `artifacts` — leaving `formatToolContent` to
 * return an empty string as the tool's text. The model saw "no output", announced
 * a failure over an image already hanging in the user's chat, and was one step
 * from paying for a retry. So: never return a bare image, and never return an
 * empty result. Say what was produced and say it succeeded.
 *
 * What it must NOT say is that the model can see the image. This server knows
 * the image left here attached to the result; it does not know what happens to
 * it after that, and on 2026-09-07 the answer on `Surplus (Claude)` was "it is
 * removed in transit" — the file was saved, the user saw it, and the model's
 * turn was billed 454 new input tokens where a 1600x1600 image alone is ~3.3k.
 * A tool that asserts something the model can plainly tell is false either gets
 * the model confabulating a description to match, or gets it filing a fault
 * against the stack. Both happened. State what is known and hand the model the
 * honest option.
 *
 * "You may or may not be able to see it" alone was not enough: a model given
 * that fork and no boundary resolves it as "the stack is broken" and escalates,
 * which is how the 2026-09-07 report happened a second time. So the text now
 * names where LibreChat's responsibility ends. That the image is in the outbound
 * request is not an assertion any more —
 * `packages/api/src/mcp/__tests__/delivery.test.ts` holds the whole chain down.
 */
function buildResultSummary({
  model,
  fileId,
  dims,
  mimeType,
  bytes,
  usage,
  aspect_ratio,
  referenceRequested,
  referenceUsed,
  oversized,
}) {
  const MODEL = model.id;
  const deliveredName = dims ? nearestRatio(dims, ASPECT_RATIOS) : null;
  const lines = [];

  if (oversized) {
    lines.push(
      `Image generated successfully, but at ${formatBytes(bytes)} it is too large to inline ` +
        `(limit ${formatBytes(MAX_INLINE_IMAGE_BYTES)}), so it is NOT attached to this result and ` +
        'will not appear in the chat. The generation was still billed. Retry with a smaller ' +
        'aspect_ratio if the user needs to see it.',
    );
  } else {
    lines.push(
      'Image generated. It is already displayed in the chat, so the user can see it — you ' +
        `do not need to do anything to show it to them. Do not call ${GENERATE_TOOL} again for ` +
        'this one; every call is billed and counts against the daily limit.',
    );
  }

  lines.push('');
  if (!oversized) {
    lines.push(
      `- file_id: ${fileId} — pass this as \`reference_image_url\` to edit or re-use this image. ` +
        `(If it does not resolve, call ${LIST_TOOL}: this image is the newest entry, INDEX_1.)`,
    );
  }
  lines.push(`- model: ${MODEL} (via ${model.provider === 'surplus' ? 'Surplus Intelligence' : 'OpenRouter'})`);
  lines.push(`- format: ${mimeType}`);
  lines.push(
    dims
      ? `- dimensions: ${dims.width}×${dims.height} (${orientationOf(dims)}` +
          `${deliveredName ? `, ${deliveredName}` : ''})`
      : `- dimensions: could not be read from the ${mimeType} header`,
  );
  lines.push(`- size: ${formatBytes(bytes)}`);

  if (aspect_ratio) {
    const requested = ratioValue(aspect_ratio);
    const honoured = dims && ratiosMatch(requested, dims.width / dims.height);
    lines.push(
      aspect_ratio === 'auto' || !dims || honoured
        ? `- aspect_ratio: requested ${aspect_ratio}`
        : `- aspect_ratio: requested ${aspect_ratio}, delivered ` +
            `${deliveredName ?? `${dims.width}:${dims.height}`}. ${MODEL} treats this argument as ` +
            'an orientation hint rather than an exact ratio, so a mismatch is expected — it is ' +
            'not a failure, and re-running with the same value will not change it.',
    );
  }

  if (referenceRequested > 0) {
    lines.push(
      referenceUsed === referenceRequested
        ? `- reference images used: ${referenceUsed}`
        : `- reference images: ${referenceUsed} of ${referenceRequested} used. The rest could ` +
            'not be read and were SKIPPED, so this is closer to a fresh generation than an ' +
            `edit — tell the user, and re-check the ids with ${LIST_TOOL}.`,
    );
  }

  if (usage?.cost != null) {
    lines.push(
      `- cost: $${Number(usage.cost).toFixed(5)} (server OpenRouter key)`,
    );
  } else if (model.provider === 'surplus') {
    lines.push(
      model.price != null
        ? `- cost: about $${model.price} list price (server Surplus key; the marketplace usually settles ` +
            'below list, and the settled figure is recorded later)'
        : '- cost: not reported per call by Surplus (server Surplus key)',
    );
  } else {
    lines.push('- cost: not reported by OpenRouter for this call');
  }

  return lines.join('\n');
}

/** The provider-specific call, chosen by the registry entry. */
async function generateWith(model, args) {
  if (model.provider === 'surplus') {
    return generateImageOnSurplus({ ...args, apiKey: surplusKey() });
  }
  return generateImageOnOpenRouter({ ...args, apiKey: openRouterKey() });
}

export async function handleGenerateImage(
  { prompt, model: requestedModel, reference_image_url, reference_image_urls, aspect_ratio },
  context,
) {
  try {
    const model = findModel(requestedModel || DEFAULT_MODEL);
    if (!model) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown model "${requestedModel}". This server is not configured for it.` }],
      };
    }
    const keyName = model.provider === 'surplus' ? 'SURPLUS_IMAGE_KEY' : 'OPENROUTER_KEY';
    if (!(model.provider === 'surplus' ? surplusKey() : openRouterKey())) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${keyName} is not set on the server, so ${model.id} cannot be used.` }],
      };
    }

    const store = context.getStore();
    const userId = store?.userId;

    const limitCheck = await checkImageGenerationLimit(userId);
    if (!limitCheck.allowed) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Limit Exceeded: ${limitCheck.reason}` }],
      };
    }
    const capCheck = await checkSurplusWeeklyCap(model);
    if (!capCheck.allowed) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Limit Exceeded: ${capCheck.reason}` }],
      };
    }

    const wantsEdit = Boolean(reference_image_url || (reference_image_urls && reference_image_urls.length > 0));
    if (model.provider === 'surplus' && notRoutingSince(model.id) != null) {
      return {
        isError: true,
        content: [{ type: 'text', text: notRoutingMessage(model, { needsEdit: wantsEdit }) }],
      };
    }

    const rawUrlsToFetch = [];
    if (reference_image_urls && reference_image_urls.length > 0) {
      rawUrlsToFetch.push(...reference_image_urls);
    } else if (reference_image_url) {
      rawUrlsToFetch.push(reference_image_url);
    }

    const urlsToFetch = await resolveImageIds(rawUrlsToFetch, userId);

    // Surplus answers a reference sent to a text-only model with a 400 after the
    // round-trip; saying so here is free and names the alternative.
    if (urlsToFetch.length > 0 && !canEdit(model)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `${model.id} is text-to-image only and cannot take reference images. Either drop the ` +
              'references, or pick a model whose description says image-to-image.',
          },
        ],
      };
    }

    console.log(
      `Generating image. Model: ${model.id} (${model.provider}), Aspect Ratio: ${aspect_ratio || 'default'}, References: ${urlsToFetch.length}`,
    );

    const dataUrls = await referencesToDataUrls({ urlsToFetch, fetchImageById, extractFileId });
    const { base64Image, mimeType, usage, referencesUsed, requestId, requestedAt, adaptedParams } =
      await generateWith(model, { prompt, selectedModel: model.id, dataUrls, aspect_ratio });

    const buffer = Buffer.from(base64Image, 'base64');
    const dims = imageDimensions(buffer);

    /**
     * Chosen here rather than left to LibreChat, which otherwise mints a v4 of its
     * own inside `saveBase64Image` and never tells anyone what it was. Sent on the
     * image block's `_meta`; `formatToolContent` lifts it into `artifact.file_ids`
     * and `createToolEndCallback` saves the file under it. That makes the id in the
     * summary below a real handle the model can pass straight back as
     * `reference_image_url` — no `get_user_images` round-trip to edit what it just
     * made. If the api image predates that fork change the id is simply not the
     * one on disk, which is why `get_user_images` is named as the fallback.
     */
    const fileId = randomUUID();

    console.log(
      `Image generated (${mimeType}, ${dims ? `${dims.width}x${dims.height}` : 'unknown size'}, ` +
        `${buffer.length} bytes), file_id=${fileId}, refs=${referencesUsed}/${urlsToFetch.length}, ` +
        `cost=${usage?.cost ?? (model.price != null ? `list ${model.price}` : 'unknown')}` +
        `${requestId ? `, request_id=${requestId}` : ''}`,
    );
    await logImageGenerationUsage(userId, prompt, model, usage, {
      fileId,
      requestId,
      requestedAt,
      adaptedParams,
      dims,
      bytes: buffer.length,
      referencesRequested: urlsToFetch.length,
      referencesUsed,
    });

    const oversized = buffer.length > MAX_INLINE_IMAGE_BYTES;
    const content = [
      {
        type: 'text',
        text: buildResultSummary({
          model,
          fileId,
          dims,
          mimeType,
          bytes: buffer.length,
          usage,
          aspect_ratio,
          referenceRequested: urlsToFetch.length,
          referenceUsed: referencesUsed,
          oversized,
        }),
      },
    ];
    if (!oversized) {
      content.push({
        type: 'image',
        data: base64Image,
        mimeType,
        _meta: { 'librechat/file_id': fileId },
      });
    }

    return { content };
  } catch (err) {
    if (err instanceof SurplusNotRoutingError) {
      const model = findModel(err.model);
      markNotRouting(err.model);
      console.warn(`Surplus not routing ${err.model}: ${err.detail}`);
      const needsEdit = Boolean(reference_image_url || (reference_image_urls && reference_image_urls.length > 0));
      return {
        isError: true,
        content: [{ type: 'text', text: notRoutingMessage(model ?? { id: err.model }, { needsEdit }) }],
      };
    }
    // Both gateways put the actionable part in the response body — an unsupported
    // aspect_ratio, for instance, is a 400 that names the values it will accept,
    // and Surplus's `not a valid model ID` is the only sign a listed model is not
    // actually routable.
    // Surfacing only err.message ("Request failed with status code 400") strands
    // the agent, so pass the body through.
    let detail = err.message;
    if (err.response) {
      const body = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString('utf8')
        : JSON.stringify(err.response.data);
      console.error('Response:', err.response.status, body.substring(0, 500));
      detail = `${err.message} — HTTP ${err.response.status}: ${body.substring(0, 500)}`;
    }
    console.error('Error in generate_image:', detail);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${detail}` }],
    };
  }
}
