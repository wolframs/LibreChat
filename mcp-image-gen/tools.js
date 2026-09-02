import { ObjectId } from 'mongodb';
import { getDb } from './db.js';
import { fetchImageById, extractFileId } from './files.js';
import { generateImageOnOpenRouter } from './openrouter.js';

export const MODEL = process.env.IMAGE_GEN_MODEL || 'meta/muse-image';

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
          text: `Found ${images.length} uploaded image(s):\n${list}\n\nUse EITHER the file_id OR the index number (e.g., '1', '2' or 'INDEX_1', 'INDEX_2') as the reference_image_url/reference_image_urls when calling generate_image.`,
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
 * One row per generation. `cost` is OpenRouter's own settled figure for the call,
 * kept because this spend never reaches LibreChat's `transactions` collection and
 * is therefore invisible to /cost — this collection is the only record of it.
 */
async function logImageGenerationUsage(userId, prompt, model, usage) {
  if (!userId) return;
  try {
    const db = await getDb();
    await db.collection('mcp_image_gen_usage').insertOne({
      userId: new ObjectId(userId),
      createdAt: new Date(),
      prompt,
      model,
      cost: usage?.cost ?? null,
      usage: usage ?? null,
    });
  } catch (err) {
    console.error('Failed to log image generation usage to DB:', err.message);
  }
}

export async function handleGenerateImage(
  { prompt, reference_image_url, reference_image_urls, aspect_ratio },
  context,
) {
  try {
    const apiKey = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'OPENROUTER_KEY is not set on the server.' }],
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

    const rawUrlsToFetch = [];
    if (reference_image_urls && reference_image_urls.length > 0) {
      rawUrlsToFetch.push(...reference_image_urls);
    } else if (reference_image_url) {
      rawUrlsToFetch.push(reference_image_url);
    }

    const urlsToFetch = await resolveImageIds(rawUrlsToFetch, userId);

    console.log(
      `Generating image. Model: ${MODEL}, Aspect Ratio: ${aspect_ratio || 'default'}, References: ${urlsToFetch.length}`,
    );

    const { base64Image, mimeType, usage } = await generateImageOnOpenRouter({
      prompt,
      selectedModel: MODEL,
      urlsToFetch,
      fetchImageById,
      extractFileId,
      apiKey,
      aspect_ratio,
    });

    console.log(`Image generated (${mimeType}), cost=${usage?.cost ?? 'unknown'}`);
    await logImageGenerationUsage(userId, prompt, MODEL, usage);
    return {
      content: [{ type: 'image', data: base64Image, mimeType }],
    };
  } catch (err) {
    // OpenRouter puts the actionable part in the response body — an unsupported
    // aspect_ratio, for instance, is a 400 that names the values it will accept.
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
