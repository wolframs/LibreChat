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
