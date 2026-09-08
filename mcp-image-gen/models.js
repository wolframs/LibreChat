import axios from 'axios';

/**
 * The model registry: which image models `generate_image` may be asked for, and
 * which provider each one is reached through.
 *
 * `IMAGE_GEN_MODELS` is a comma-separated allowlist. The first entry is the
 * default unless `IMAGE_GEN_MODEL` names another one. Each entry is `[provider:]id`,
 * and the provider is inferred when absent:
 *
 *   - an id with a slash (`meta/muse-image`, `google/gemini-3-pro-image`) is an
 *     OpenRouter id — every OpenRouter model is `vendor/name`;
 *   - an id without one (`venice-sd35`, `grok-imagine-edit`) is a Surplus
 *     Intelligence id — the marketplace flattens vendor into the name.
 *
 * `surplus:` / `openrouter:` prefixes override the inference for the day a
 * counter-example appears.
 *
 * Membership in this list is deliberately NOT checked against either catalogue at
 * startup. Surplus lists 55 image-output models in `/v1/models` and routes only
 * some of them — `venice-z-image-turbo`, `venice-seedream-v5-lite` and
 * `venice-hunyuan-image-v3` were all in the catalogue and answered
 * `not a valid model ID` on 2026-09-08 — and `/v1/prices` shows `providers: []`
 * for every image model, so nothing on the API side says what is routable. The
 * only test is a paid request. So the list is hand-kept and a bad entry fails
 * loudly on first use, with the gateway's own message, rather than being
 * filtered out silently and leaving the model to wonder where it went.
 */
const PROVIDERS = new Set(['openrouter', 'surplus']);

function parseEntry(raw) {
  const entry = raw.trim();
  if (!entry) return null;
  const colon = entry.indexOf(':');
  if (colon > 0) {
    const prefix = entry.slice(0, colon).toLowerCase();
    if (PROVIDERS.has(prefix)) {
      return { id: entry.slice(colon + 1).trim(), provider: prefix };
    }
  }
  return { id: entry, provider: entry.includes('/') ? 'openrouter' : 'surplus' };
}

export function parseModelList(list, defaultId) {
  const models = [];
  const seen = new Set();
  for (const raw of String(list || '').split(',')) {
    const parsed = parseEntry(raw);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    models.push({ ...parsed, price: null, unit: null, features: [], label: null });
  }
  if (models.length === 0) {
    models.push({ ...parseEntry('meta/muse-image'), price: 0.01, unit: 'image', features: [], label: null });
  }
  const preferred = defaultId && models.find((m) => m.id === defaultId.trim());
  return { models, defaultModel: preferred ? preferred.id : models[0].id };
}

const { models: MODELS, defaultModel: DEFAULT_MODEL } = parseModelList(
  process.env.IMAGE_GEN_MODELS || process.env.IMAGE_GEN_MODEL || 'meta/muse-image',
  process.env.IMAGE_GEN_MODEL,
);

export { MODELS, DEFAULT_MODEL };
export const MODEL_IDS = MODELS.map((m) => m.id);

export function findModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}

/** Whether the Surplus catalogue says a model takes reference images. */
export function canEdit(model) {
  if (model.provider === 'openrouter') return true; // both OpenRouter routes accept references
  return model.features.includes('image_edit') || model.features.includes('image-to-image');
}

/**
 * Fill in list prices and capability flags from the Surplus catalogue. These are
 * for the tool description and the nominal cost line only — the routing above
 * does not depend on them, so a failed fetch degrades to "price unknown" rather
 * than to a missing tool. Known list prices are pre-filled so the description is
 * right even when the fetch fails (the values are `pricing.image` as of
 * 2026-09-08 and are overwritten by whatever the catalogue says today).
 */
const KNOWN_PRICES = {
  'meta/muse-image': [0.01, 'image'],
  'venice-sd35': [0.01, 'image'],
  'venice-lustify-sdxl': [0.01, 'image'],
  'venice-wan-2.7': [0.01, 'image'],
  'venice-qwen-image': [0.01, 'image'],
  'grok-imagine-edit': [0.04, 'image'],
};

export async function loadCatalogue({ surplusKey, surplusBase, timeoutMs = 8000 } = {}) {
  for (const m of MODELS) {
    const known = KNOWN_PRICES[m.id];
    if (known) [m.price, m.unit] = known;
    if (m.id === 'grok-imagine-edit') m.features = ['image_edit'];
  }

  const wantsSurplus = MODELS.some((m) => m.provider === 'surplus');
  if (!wantsSurplus || !surplusKey) return { fetched: false };

  try {
    const res = await axios.get(`${surplusBase}/v1/models`, {
      headers: { Authorization: `Bearer ${surplusKey}` },
      timeout: timeoutMs,
    });
    const rows = res.data?.data ?? res.data ?? [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    let matched = 0;
    for (const m of MODELS) {
      if (m.provider !== 'surplus') continue;
      const row = byId.get(m.id);
      if (!row) continue;
      matched += 1;
      const price = Number(row.pricing?.image);
      if (Number.isFinite(price) && price > 0) {
        m.price = price;
        m.unit = row.pricing?.media_unit || 'image';
      }
      m.features = Array.isArray(row.supported_features) ? row.supported_features : [];
      m.label = row.name || null;
    }
    return { fetched: true, matched };
  } catch (err) {
    console.warn(`Surplus catalogue fetch failed (${err.message}); using built-in prices`);
    return { fetched: false, error: err.message };
  }
}

function priceText(m) {
  if (m.price == null) return 'price unknown';
  return `$${m.price}/${m.unit || 'image'} list`;
}

/**
 * The `model` argument's description, built from the registry so the model
 * choosing sees the same list the server will accept — with provider, price and
 * whether references are allowed, which are the three things that decide the
 * pick. Text-only models are named as such because a reference sent to one is a
 * hard 400 from Surplus (`model_capability_unsupported`).
 */
export function describeModels() {
  const lines = MODELS.map((m) => {
    const bits = [m.provider === 'surplus' ? 'Surplus' : 'OpenRouter', priceText(m)];
    bits.push(canEdit(m) ? 'text-to-image and image-to-image' : 'text-to-image only (no references)');
    if (m.features.includes('uncensored')) bits.push('uncensored');
    if (m.features.includes('anime')) bits.push('anime');
    return `'${m.id}' (${bits.join('; ')})${m.id === DEFAULT_MODEL ? ' — default' : ''}`;
  });
  return (
    `Which image model to use. Defaults to '${DEFAULT_MODEL}'. Choose by what the user asked ` +
    'for; do not switch models to "retry" a result you disliked. A Surplus model can be ' +
    '"not routing right now" (no seller at this moment) — the result says so, nothing is billed, ' +
    `and switching model is then correct. Options: ${lines.join(', ')}.`
  );
}
