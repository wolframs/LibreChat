import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo;
let tools;
let db;
const originalPost = axios.post;
const userId = new ObjectId().toHexString();

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri('image-error-integration');
  process.env.OPENROUTER_KEY = 'offline-test-only';
  process.env.IMAGE_GEN_COOLDOWN_SEC = '0';
  process.env.IMAGE_GEN_DAILY_LIMIT = '0';
  process.env.IMAGE_GEN_MODELS = 'meta/muse-image';
  tools = await import('../tools.js');
  db = await import('../db.js').then((module) => module.getDb());
});

after(async () => {
  axios.post = originalPost;
  await import('../db.js').then((module) => module.closeDb());
  await mongo?.stop();
});

async function providerFailure(body) {
  let providerCalls = 0;
  axios.post = async (url) => {
    providerCalls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/images');
    const error = new Error('Request failed with status code 400');
    error.response = { status: 400, data: body };
    throw error;
  };
  const result = await tools.handleGenerateImage(
    { prompt: 'offline synthetic prompt', model: 'meta/muse-image' },
    { getStore: () => ({ userId }) },
  );
  assert.equal(providerCalls, 1);
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(await db.collection('mcp_image_gen_usage').countDocuments(), 0);
  return result.content[0].text;
}

test('insufficient-credit HTTP 400 reaches the model as an error without an image or usage', async () => {
  const text = await providerFailure({
    error: { code: 'insufficient_credit', message: 'Top up credit to continue.' },
  });
  assert.match(text, /HTTP 400/);
  assert.match(text, /insufficient_credit/);
  assert.match(text, /Top up credit/);
});

test('moderation HTTP 400 gives a switch-model explanation without an image or usage', async () => {
  const text = await providerFailure({
    error: { code: 'content_policy', message: 'Content management policy refusal.' },
  });
  assert.match(text, /HTTP 400/);
  assert.match(text, /content_policy/);
  assert.match(text, /provider's content filter/);
  assert.match(text, /No image was returned/);
  assert.doesNotMatch(text, /Nothing was billed/);
  assert.match(text, /tell the user/);
});
