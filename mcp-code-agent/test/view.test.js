import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../view.js', import.meta.url), 'utf8');
const compiled = source
  .replace("import { getDb } from './db.js';", '')
  .replace("import { describeTokens } from './tokens.js';", '')
  .replace('export function mountView(app, health)', 'function mountView(app, health)');

async function page(jobs) {
  const rows = Array.isArray(jobs) ? jobs : [jobs];
  const routes = new Map();
  const app = { get: (route, handler) => routes.set(route, handler) };
  const getDb = async () => ({
    collection: () => ({
      find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => rows }) }) }),
    }),
  });
  const state = {
    branch: 'preview',
    head: '0000000',
    clean: true,
    agentAvailable: true,
    activeJob: rows[0]?._id,
    dailyLimit: 3,
    worktrees: [],
    stale: [],
  };
  new Script(compiled + '\nmountView(app, async () => state);').runInNewContext({
    app,
    getDb,
    state,
    describeTokens: () => 'test tokens',
    Date,
    process,
  });
  let html;
  const response = {
    type: () => response,
    send: (body) => {
      html = body;
    },
  };
  await routes.get('/agent')({}, response);
  return html;
}

const job = (text) => ({
  _id: 'synthetic-job',
  status: 'running',
  createdAt: '2026-09-15T12:00:00.000Z',
  premise: text,
});

test('agent page has in-place refresh, manual retry, and no full-page meta refresh', async () => {
  const first = await page(job('Before'));
  assert.doesNotMatch(first, /http-equiv="refresh"/);
  assert.match(first, /id="agent-refresh"/);
  assert.match(first, /data-refresh-ms="5000"/);
  assert.match(first, /prefers-reduced-motion/);
});

test('refresh preserves selected card and updates it in place after selection clears', async () => {
  const first = await page(job('Before'));
  const second = await page(job('After'));
  const dom = new JSDOM(first, { url: 'https://localhost/agent', runScripts: 'outside-only' });
  const { window } = dom;
  const callbacks = [];
  window.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  window.clearTimeout = () => {};
  window.fetch = async () => ({ ok: true, text: async () => second });
  const script = window.document.querySelector('script').textContent;
  window.eval(script);
  const card = window.document.querySelector('[data-job-id="synthetic-job"]');
  const text = card.querySelector('blockquote').firstChild;
  const range = window.document.createRange();
  range.selectNodeContents(text);
  window.getSelection().addRange(range);
  await callbacks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card.querySelector('blockquote').textContent, 'Before');
  assert.equal(window.document.querySelector('[data-job-id="synthetic-job"]'), card);
  window.getSelection().removeAllRanges();
  const refreshButton = window.document.getElementById('agent-refresh');
  refreshButton.focus();
  refreshButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card.querySelector('blockquote').textContent, 'After');
  assert.equal(window.document.querySelector('[data-job-id="synthetic-job"]'), card);
  assert.equal(window.document.activeElement, refreshButton);
  assert.equal(window.document.getElementById('refresh-status').textContent, 'Updated.');
  dom.window.close();
});

test('hung refresh aborts, reports retry, and keeps the manual button focused', async () => {
  const first = await page(job('Before'));
  const second = await page(job('After'));
  const dom = new JSDOM(first, { url: 'https://localhost/agent', runScripts: 'outside-only' });
  const { window } = dom;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  let aborted = false;
  window.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });
  window.eval(window.document.querySelector('script').textContent);
  const button = window.document.getElementById('agent-refresh');
  button.focus();
  button.click();
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(window.document.activeElement, button);
  const timeout = Array.from(timers.values()).find((entry) => entry.delay === 10000);
  assert.ok(timeout);
  timeout.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(button.hasAttribute('aria-disabled'), false);
  assert.equal(window.document.activeElement, button);
  assert.match(window.document.getElementById('refresh-status').textContent, /timed out.*retrying/);
  window.fetch = async () => ({ ok: true, text: async () => second });
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.document.querySelector('blockquote').textContent, 'After');
  assert.equal(window.document.getElementById('refresh-status').textContent, 'Updated.');
  dom.window.close();
});

test('selection spanning three cards pins the middle card until selection clears', async () => {
  const rows = ['one', 'two', 'three'].map((id) => ({
    ...job('Before ' + id),
    _id: id,
  }));
  const nextRows = rows.map((row) => ({ ...row, premise: 'After ' + row._id }));
  const first = await page(rows);
  const second = await page(nextRows);
  const dom = new JSDOM(first, { url: 'https://localhost/agent', runScripts: 'outside-only' });
  const { window } = dom;
  const callbacks = [];
  window.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  window.clearTimeout = () => {};
  window.fetch = async () => ({ ok: true, text: async () => second });
  window.eval(window.document.querySelector('script').textContent);
  const cards = Array.from(window.document.querySelectorAll('#agent-cards article'));
  const range = window.document.createRange();
  range.setStart(cards[0].querySelector('blockquote').firstChild, 0);
  range.setEnd(cards[2].querySelector('blockquote').firstChild, 5);
  window.getSelection().addRange(range);
  await callbacks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cards[1].querySelector('blockquote').textContent, 'Before two');
  assert.equal(window.document.querySelector('[data-job-id="two"]'), cards[1]);
  window.getSelection().removeAllRanges();
  window.document.getElementById('agent-refresh').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cards[1].querySelector('blockquote').textContent, 'After two');
  dom.window.close();
});
