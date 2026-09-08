import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelList } from '../models.js';
import { sizeForRatio, sniffMime } from '../surplus.js';

test('a slash means OpenRouter, no slash means Surplus, a prefix overrides', () => {
  const { models, defaultModel } = parseModelList(
    'meta/muse-image, venice-sd35,surplus:odd/one, openrouter:bare ,venice-sd35',
  );
  assert.deepEqual(
    models.map((m) => [m.id, m.provider]),
    [
      ['meta/muse-image', 'openrouter'],
      ['venice-sd35', 'surplus'],
      ['odd/one', 'surplus'],
      ['bare', 'openrouter'],
    ],
  );
  assert.equal(defaultModel, 'meta/muse-image');
});

test('IMAGE_GEN_MODEL picks the default only when it is in the list', () => {
  assert.equal(parseModelList('a/b,venice-sd35', 'venice-sd35').defaultModel, 'venice-sd35');
  assert.equal(parseModelList('a/b,venice-sd35', 'not-listed').defaultModel, 'a/b');
});

test('an empty list falls back to meta/muse-image', () => {
  assert.equal(parseModelList('').defaultModel, 'meta/muse-image');
});

test('aspect ratios map onto the sizes the gateway accepted on 2026-09-08', () => {
  assert.equal(sizeForRatio(undefined), '1024x1024');
  assert.equal(sizeForRatio('auto'), '1024x1024');
  assert.equal(sizeForRatio('1:1'), '1024x1024');
  assert.equal(sizeForRatio('3:2'), '1536x1024');
  assert.equal(sizeForRatio('4:3'), '1536x1024');
  assert.equal(sizeForRatio('16:9'), '1792x1024');
  assert.equal(sizeForRatio('21:9'), '1792x1024');
  assert.equal(sizeForRatio('2:3'), '1024x1536');
  assert.equal(sizeForRatio('4:5'), '1024x1536');
  assert.equal(sizeForRatio('9:16'), '1024x1792');
});

test('the container is read off the bytes because the response names none', () => {
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp');
});

import { isNotRoutingResponse, SurplusNotRoutingError } from '../surplus.js';
import { markNotRouting, notRoutingSince, notRoutingMessage, NOT_ROUTING_WINDOW_MS, GENERATE_TOOL } from '../tools.js';

test('"not a valid model ID" and no_sellers_for_model are liquidity, not typos', () => {
  assert.equal(isNotRoutingResponse(400, { error: { code: 'request_rejected', message: 'venice-sd35 is not a valid model ID. Unusual bug?' } }), true);
  assert.equal(isNotRoutingResponse(404, { error: { code: 'no_sellers_for_model', message: 'No available sellers' } }), true);
  assert.equal(isNotRoutingResponse(400, { error: { code: 'request_rejected', message: 'Invalid request parameters.' } }), false);
  assert.equal(isNotRoutingResponse(403, { error: { code: 'endpoint_not_in_key_scope', message: 'x is not a valid model ID' } }), false);
  assert.equal(new SurplusNotRoutingError('venice-sd35', 'd').model, 'venice-sd35');
});

test('a model marked not-routing is remembered for the window and then forgotten', () => {
  const t0 = 1_000_000;
  markNotRouting('venice-sd35', t0);
  assert.equal(notRoutingSince('venice-sd35', t0 + 1000), t0);
  assert.equal(notRoutingSince('venice-sd35', t0 + NOT_ROUTING_WINDOW_MS + 1), null);
  assert.equal(notRoutingSince('venice-sd35', t0 + 1000), null, 'expiry is permanent once seen');
});

test('the not-routing message names alternatives that fit the call and skips ones also down', () => {
  const t0 = 2_000_000;
  markNotRouting('venice-sd35', t0);
  const sd35 = { id: 'venice-sd35', provider: 'surplus', features: [] };
  const plain = notRoutingMessage(sd35, { needsEdit: false, now: t0 });
  assert.match(plain, /not routing venice-sd35 right now/);
  assert.match(plain, /Nothing was billed/);
  assert.match(plain, /'meta\/muse-image' \(OpenRouter, always routable\)/);
  assert.match(plain, /for the next 3 minute\(s\)/);
  const edit = notRoutingMessage(sd35, { needsEdit: true, now: t0 });
  assert.doesNotMatch(edit, /venice-lustify-sdxl/, 'text-only models are not offered for an edit');
});

test('model-facing text uses the registered tool name, not the bare one', () => {
  assert.equal(GENERATE_TOOL, 'generate_image_mcp_imager');
});
