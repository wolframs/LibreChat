import axios from 'axios';

/**
 * Two OpenRouter routes reach an image model, and they are not interchangeable:
 *
 *  - POST /api/v1/images        the dedicated image API. Body is {model, prompt,
 *                               aspect_ratio, input_references}; the response is
 *                               {data: [{b64_json, media_type}], usage: {cost}}.
 *                               This is the route for models whose catalogue
 *                               `output_modalities` is image-only — meta/muse-image
 *                               among them.
 *  - POST /api/v1/chat/completions with `modalities: ["image","text"]`
 *                               for models that answer in text AND image (the
 *                               Gemini *-image family). Their image comes back
 *                               inside the assistant message, in one of three
 *                               shapes, which is why that branch is so defensive.
 *
 * IMAGE_GEN_API=auto|images|chat picks; auto keeps upstream's heuristic.
 */
function useChatRoute(model) {
  const mode = (process.env.IMAGE_GEN_API || 'auto').toLowerCase();
  if (mode === 'chat') return true;
  if (mode === 'images') return false;
  return model.includes('gemini');
}

async function downloadImage(url) {
  try {
    console.log(`Downloading remote image from: ${url}`);
    const downloadRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const contentType = downloadRes.headers['content-type'] || 'image/png';
    const base64 = Buffer.from(downloadRes.data).toString('base64');
    return { base64, contentType };
  } catch (err) {
    console.error('Failed to download image from URL:', url, err.message);
    throw new Error(`Failed to download image: ${err.message}`);
  }
}

/**
 * Resolve reference file_ids to `data:` URLs, skipping any that cannot be read.
 * Shared by both providers: the same data URI is what OpenRouter's
 * `input_references` and Surplus's `input_images` take.
 */
export async function referencesToDataUrls({ urlsToFetch, fetchImageById, extractFileId }) {
  const out = [];
  for (const refUrl of urlsToFetch) {
    const fileId = extractFileId(refUrl);
    console.log(`Extracted file_id: "${fileId}" from: "${refUrl}"`);
    try {
      const { buffer, contentType } = await fetchImageById(fileId);
      out.push(`data:${contentType};base64,${buffer.toString('base64')}`);
    } catch (fetchErr) {
      console.warn(`[Warning] Skipping reference image "${fileId}": ${fetchErr.message}`);
    }
  }
  return out;
}

export async function generateImageOnOpenRouter({ prompt, selectedModel, dataUrls, apiKey, aspect_ratio }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  let base64Image = null;
  let mimeType = 'image/png';
  let usage = null;

  if (useChatRoute(selectedModel)) {
    // Chat models take the ratio as prose as well; the dedicated API does not need this.
    const finalPrompt = aspect_ratio ? `${prompt} (Aspect ratio: ${aspect_ratio})` : prompt;
    console.log(`Calling OpenRouter chat/completions (modalities): ${selectedModel}...`);

    const content = [{ type: 'text', text: finalPrompt }];
    for (const url of dataUrls) {
      content.push({ type: 'image_url', image_url: { url } });
    }
    const messages = [{ role: 'user', content: content.length > 1 ? content : finalPrompt }];

    const orResponse = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: selectedModel,
        messages,
        modalities: ['image', 'text'],
        ...(aspect_ratio ? { image_config: { aspect_ratio } } : {}),
      },
      { headers, timeout: 180000 },
    );

    usage = orResponse.data?.usage ?? null;
    const message = orResponse.data?.choices?.[0]?.message;
    if (!message) throw new Error('No choices returned from OpenRouter API.');

    // 1. message.images[]
    if (message.images?.length > 0) {
      const raw = message.images[0];
      const imgUrl = typeof raw === 'string' ? raw : raw.url || raw.image_url?.url;
      if (imgUrl) {
        const decodedUrl = /data%3A|%3Bbase64%2C/.test(imgUrl) ? decodeURIComponent(imgUrl) : imgUrl;
        if (decodedUrl.startsWith('data:')) {
          const m = decodedUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (m) {
            mimeType = m[1];
            base64Image = m[2];
          }
        } else if (/^https?:\/\//.test(decodedUrl)) {
          const dl = await downloadImage(decodedUrl);
          base64Image = dl.base64;
          mimeType = dl.contentType;
        }
      }
    }

    // 2. message.content, string or array of parts
    if (!base64Image && message.content) {
      const parts = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: message.content }];

      for (const part of parts) {
        if (part.type === 'image_url' && part.image_url?.url) {
          const u = part.image_url.url;
          const decodedUrl = /data%3A|%3Bbase64%2C/.test(u) ? decodeURIComponent(u) : u;
          if (decodedUrl.startsWith('data:')) {
            const m = decodedUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (m) {
              mimeType = m[1];
              base64Image = m[2];
              break;
            }
          } else if (decodedUrl.startsWith('http')) {
            const dl = await downloadImage(decodedUrl);
            base64Image = dl.base64;
            mimeType = dl.contentType;
            break;
          }
        }

        if (part.text || typeof part === 'string') {
          let text = typeof part === 'string' ? part : part.text || '';
          if (/data%3A|%3Bbase64%2C/.test(text)) text = decodeURIComponent(text);
          const m = text.match(/data:image\/([^;]+);base64,([A-Za-z0-9+/=]+)/);
          if (m) {
            mimeType = `image/${m[1]}`;
            base64Image = m[2];
            break;
          }
        }
      }
    }
  } else {
    console.log(`Calling OpenRouter /images: ${selectedModel}...`);

    const payload = {
      model: selectedModel,
      prompt,
      ...(aspect_ratio ? { aspect_ratio } : {}),
      ...(dataUrls.length > 0
        ? { input_references: dataUrls.map((url) => ({ type: 'image_url', image_url: { url } })) }
        : {}),
    };

    const orResponse = await axios.post('https://openrouter.ai/api/v1/images', payload, {
      headers,
      timeout: 180000,
    });

    usage = orResponse.data?.usage ?? null;
    const imageData = orResponse.data?.data?.[0];
    if (!imageData) {
      throw new Error(
        `No image data returned from OpenRouter API. Response: ${JSON.stringify(orResponse.data)}`,
      );
    }

    base64Image = imageData.b64_json || null;
    // The dedicated API reports the real container in `media_type`, and it is NOT
    // always png — meta/muse-image answers in webp. Trusting the png default here
    // mislabels every generation.
    if (imageData.media_type) mimeType = imageData.media_type;

    if (!base64Image && imageData.url) {
      const dl = await downloadImage(imageData.url);
      base64Image = dl.base64;
      mimeType = dl.contentType;
    }
  }

  if (!base64Image) {
    throw new Error('Failed to extract or download image.');
  }

  // `referencesUsed` can be short of `urlsToFetch.length`: a reference that cannot
  // be read is skipped with a warning above, and the generation proceeds without
  // it. That turns "edit this image" into "generate a new one" with nothing in the
  // tool result to say so, which is the same silent-success shape as returning a
  // bare image block. The caller reports the shortfall.
  return { base64Image, mimeType, usage, requestId: null, referencesUsed: dataUrls.length };
}
