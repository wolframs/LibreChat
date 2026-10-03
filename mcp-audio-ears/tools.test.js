import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  hasKnownUsageCost,
  releaseBudgetLock,
  remainingWeeklyBudget,
  reserveBudget,
  settleUsage,
} from './tools.js';

let server;
let client;
let db;
const userId = new ObjectId().toHexString();

before(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db('audio-budget-test');
});

beforeEach(async () => {
  await db.dropDatabase();
});

after(async () => {
  await client?.close();
  await server?.stop();
});

test('remainingWeeklyBudget returns the unspent rolling allowance', () => {
  assert.equal(remainingWeeklyBudget(0.25, 1), 0.75);
});

test('remainingWeeklyBudget never returns a negative reservation', () => {
  assert.equal(remainingWeeklyBudget(1.2, 1), 0);
});

test('hasKnownUsageCost requires every call and the matching total to be trustworthy', () => {
  assert.equal(hasKnownUsageCost({ calls: [{ cost: 0.1 }, { cost: 0.2 }], cost_total: 0.3 }), true);
  assert.equal(
    hasKnownUsageCost({ calls: [{ cost: 0.1 }, { cost: null }], cost_total: 0.1 }),
    false,
  );
  assert.equal(hasKnownUsageCost({ calls: [{ cost: -0.1 }], cost_total: -0.1 }), false);
  assert.equal(hasKnownUsageCost({ calls: [{ cost: 0.1 }], cost_total: Number.NaN }), false);
});

test('concurrent reservation admits only one listen for a user', async () => {
  const results = await Promise.all([reserveBudget(userId, db), reserveBudget(userId, db)]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.equal(results.filter((result) => !result.allowed).length, 1);
  await releaseBudgetLock(results.find((result) => result.allowed));
});

test('lease loss after reservation is fenced before provider dispatch', async () => {
  const result = await reserveBudget(userId, db, {
    afterReservationInserted: async ({ db: hookDb, userObjectId }) => {
      await hookDb
        .collection('mcp_audio_ears_locks')
        .updateOne(
          { _id: userObjectId },
          { $set: { owner: 'new-owner', leaseUntil: new Date(Date.now() + 60_000) } },
        );
    },
  });

  assert.equal(result.allowed, false);
  const reservation = await db.collection('mcp_audio_ears_usage').findOne({ status: 'canceled' });
  assert.equal(reservation.cost, 0);
  assert.equal(reservation.reservedCost, 0);
});

test('an unexpired lock remains held and rejects another owner', async () => {
  await db.collection('mcp_audio_ears_locks').insertOne({
    _id: new ObjectId(userId),
    owner: 'stalled-owner',
    leaseUntil: new Date(Date.now() + 60_000),
  });

  assert.equal((await reserveBudget(userId, db)).allowed, false);
});

test('zero-cost settlement returns the allowance and releases the mutex', async () => {
  const first = await reserveBudget(userId, db);
  await settleUsage(first, null, 'model', { calls: [{ cost: 0 }], cost_total: 0 }, {});
  await releaseBudgetLock(first);

  const second = await reserveBudget(userId, db);
  assert.equal(second.allowed, true);
  assert.equal(second.reservedCost, 1);
  await releaseBudgetLock(second);
});

test('unknown partial usage durably retains the reservation', async () => {
  const first = await reserveBudget(userId, db);
  await settleUsage(
    first,
    null,
    'model',
    { calls: [{ cost: 0.1 }, { error: 'HTTP 500' }], cost_total: null },
    { failed: true },
  );
  await releaseBudgetLock(first);

  const row = await db.collection('mcp_audio_ears_usage').findOne({ _id: first.reservationId });
  assert.equal(row.status, 'unknown');
  assert.equal(row.reservedCost, 1);
  assert.equal((await reserveBudget(userId, db)).allowed, false);
});

test('spend older than seven days does not consume the rolling allowance', async () => {
  await db.collection('mcp_audio_ears_usage').insertOne({
    userId: new ObjectId(userId),
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    cost: 1,
  });

  const reservation = await reserveBudget(userId, db);
  assert.equal(reservation.allowed, true);
  assert.equal(reservation.reservedCost, 1);
  await releaseBudgetLock(reservation);
});

test('legacy unknown-cost usage inside the window blocks admission', async () => {
  await db.collection('mcp_audio_ears_usage').insertOne({
    userId: new ObjectId(userId),
    createdAt: new Date(),
    cost: null,
  });

  const reservation = await reserveBudget(userId, db);
  assert.equal(reservation.allowed, false);
});
