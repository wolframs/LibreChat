import axios from 'axios';

/**
 * Surplus Intelligence reaches its image models through the OpenAI images
 * shape, not OpenRouter's:
 *
 *  - POST /v1/images/generations   {model, prompt, n, size, quality, response_format}
 *  - POST /v1/images/edits         the same plus `image` (one) or `input_images`
 *                                  (up to 8; the first is the base, the rest are
 *                                  reference layers), each an https URL or a
 *                                  `data:` URI. JSON, not multipart.
 *
 * Both answer {created, data: [{b64_json}]} — no `media_type`, no `usage`, and no
 * cost header either (`x-si-buyer-cost-micro` is in the CORS expose list and
 * absent from every response measured). The settled charge exists only in the
 * buyer usage export, an hour later, so the caller records the catalogue list
 * price as nominal and `cost-dashboard/reconcile.py` writes the real figure onto
 * the usage row afterwards.
 *
 * Everything here was measured against the live gateway on 2026-09-08:
 *
 *  - `size` is validated against a closed set. 1024x1024, 1536x1024, 1024x1536
 *    and 1792x1024 are accepted; 1344x768, 896x1120, 1920x1080 and friends are
 *    `Invalid request parameters` — the OpenAI set, in other words. So this
 *    gateway honours orientation and not the exact ratio, the same as
 *    meta/muse-image, just with a different pair of shapes.
 *  - `aspect_ratio` is rejected outright even on models whose catalogue
 *    `supported_features` lists it. Do not send it.
 *  - A text-only model on `/edits` is a loud 400 (`model_capability_unsupported`);
 *    an edit model on `/generations` works as text-to-image.
 *  - `/edits` rejects `n` (`Invalid request parameters`, the same message it
 *    gives an unknown size) while `/generations` accepts it. The message names
 *    nothing, so when a request that worked by hand fails from here, diff the
 *    bodies before the code.
 *  - Every Venice-served response carried `x-si-adapted-params: safe_mode`. What
 *    was adapted, and to which value, is not stated. Recorded, not interpreted.
 *  - A catalogue entry is not a routable model (see models.js).
 */
export const SURPLUS_BASE = (process.env.SURPLUS_API_BASE || 'https://api.surplusintelligence.ai').replace(
  /\/+$/,
  '',
);

/** The sizes the gateway accepted, as ratios, for nearest-match against a requested ratio. */
const SIZES = [
  { size: '1024x1024', ratio: 1 },
  { size: '1536x1024', ratio: 1.5 },
  { size: '1792x1024', ratio: 1.75 },
  { size: '1024x1536', ratio: 2 / 3 },
  { size: '1024x1792', ratio: 1024 / 1792 },
];

export function sizeForRatio(aspect_ratio) {
  if (!aspect_ratio || aspect_ratio === 'auto') return '1024x1024';
  const [w, h] = String(aspect_ratio).split(':').map(Number);
  if (!(w > 0 && h > 0)) return '1024x1024';
  const wanted = w / h;
  let best = SIZES[0];
  for (const candidate of SIZES) {
    if (Math.abs(Math.log(candidate.ratio / wanted)) < Math.abs(Math.log(best.ratio / wanted))) {
      best = candidate;
    }
  }
  return best.size;
}

/** The response names no container, so read it off the bytes. */
export function sniffMime(buffer) {
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.slice(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.slice(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  return 'image/png';
}

export async function generateImageOnSurplus({ prompt, selectedModel, dataUrls, apiKey, aspect_ratio }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const editing = dataUrls.length > 0;
  const path = editing ? '/v1/images/edits' : '/v1/images/generations';

  // No `n`: `/edits` answers `n: 1` with `Invalid request parameters` even
  // though `/generations` accepts it, and one image is the default on both.
  const payload = {
    model: selectedModel,
    prompt,
    response_format: 'b64_json',
    ...(editing ? {} : { size: sizeForRatio(aspect_ratio) }),
    ...(editing && dataUrls.length === 1 ? { image: dataUrls[0] } : {}),
    ...(editing && dataUrls.length > 1 ? { input_images: dataUrls } : {}),
  };

  console.log(`Calling Surplus ${path}: ${selectedModel}${editing ? ` with ${dataUrls.length} reference(s)` : ` size=${payload.size}`}...`);
  const started = new Date();
  const res = await axios.post(`${SURPLUS_BASE}${path}`, payload, {
    headers,
    timeout: 180000,
    // Data-URI references make the request body large; the default cap is 10 MB.
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const item = res.data?.data?.[0];
  if (!item?.b64_json && !item?.url) {
    throw new Error(`No image data returned from Surplus. Response: ${JSON.stringify(res.data).slice(0, 500)}`);
  }

  let base64Image = item.b64_json || null;
  let mimeType = null;
  if (!base64Image && item.url) {
    const dl = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 30000 });
    base64Image = Buffer.from(dl.data).toString('base64');
    mimeType = dl.headers['content-type'] || null;
  }
  if (!mimeType) mimeType = sniffMime(Buffer.from(base64Image, 'base64'));

  return {
    base64Image,
    mimeType,
    usage: null,
    requestId: res.headers['x-request-id'] || null,
    adaptedParams: res.headers['x-si-adapted-params'] || null,
    requestedAt: started,
    referencesUsed: dataUrls.length,
  };
}
