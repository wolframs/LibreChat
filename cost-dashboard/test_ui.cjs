const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');

const source = readFileSync(require.resolve('./app.py'), 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test('cost and export templates set a mobile viewport', () => {
  assert.equal((source.match(/<meta name="viewport"/g) || []).length, 2);
});

test('wide tables have keyboard-focusable, labeled horizontal scroll regions', () => {
  assert.equal((source.match(/class="table-scroll" role="region" aria-label="[^"]+" tabindex="0"/g) || []).length, 6);
  assert.match(source, /\.table-scroll \{ max-width: 100%; overflow-x: auto;/);
  assert.match(source, /\.table-scroll \{ max-width:100%; overflow-x:auto;/);
  assert.match(source, /@media \(max-width: 800px\)[\s\S]*\.summary, \.summary\.five \{ grid-template-columns: repeat\(2,/);
});

test('always-visible usage and export tables describe empty states', () => {
  assert.match(source, /\{% if not by_routing %\}\s*<tr><td colspan="8"[^>]*>No routed usage recorded yet\.<\/td><\/tr>/);
  assert.match(source, /\{% if not by_model %\}\s*<tr><td colspan="7"[^>]*>No model usage recorded yet\.<\/td><\/tr>/);
  assert.match(source, /\{% if not by_conv %\}\s*<tr><td colspan="9"[^>]*>No conversation usage recorded yet\.<\/td><\/tr>/);
  assert.match(source, /\{% if not convs %\}\s*<tr><td colspan="7"[^>]*>No conversations available to export yet\.<\/td><\/tr>/);
});

test('sortable table exposes native keyboard-operable buttons and updates aria-sort', () => {
  assert.ok(script);
  const dom = new JSDOM(`<!doctype html><table data-sortable><thead><tr>
    <th>Name</th><th>Cost</th></tr></thead><tbody>
    <tr><td>Z</td><td>$1.00</td></tr><tr><td>A</td><td>$2.00</td></tr>
    </tbody></table>`, { runScripts: 'outside-only' });
  dom.window.eval(script);
  const { document } = dom.window;
  const table = document.querySelector('table');
  const buttons = table.querySelectorAll('thead button.sort-button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].getAttribute('aria-label'), 'Sort by Cost');
  buttons[1].click();
  assert.equal(table.querySelectorAll('th')[1].getAttribute('aria-sort'), 'descending');
  assert.equal(table.tBodies[0].rows[0].cells[0].textContent, 'A');
  buttons[1].click();
  assert.equal(table.querySelectorAll('th')[1].getAttribute('aria-sort'), 'ascending');
  assert.equal(table.tBodies[0].rows[0].cells[0].textContent, 'Z');
  dom.window.close();
});

test('repeated export links name their conversation and format', () => {
  assert.match(source, /aria-label="Download \{\{ c\.title \}\} as Markdown"/);
  assert.match(source, /aria-label="Download \{\{ c\.title \}\} as JSONL"/);
  assert.match(source, /aria-label="Download \{\{ c\.title \}\} branches as ZIP"/);
});
