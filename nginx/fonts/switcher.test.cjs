const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');

const source = readFileSync(require.resolve('./switcher.js'), 'utf8');

function setup(storageDenied = false, beforeEval) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  if (storageDenied) {
    Object.defineProperty(dom.window, 'localStorage', {
      get() { throw new Error('storage denied'); },
    });
  }
  dom.window.requestAnimationFrame = (callback) => callback();
  beforeEval?.(dom.window);
  dom.window.eval(source);
  return dom;
}

test('opens with focus in the dialog and restores focus on Escape', () => {
  const dom = setup();
  const { document, KeyboardEvent } = dom.window;
  const button = document.querySelector('.lcfs-btn');
  button.click();
  const panel = document.querySelector('.lcfs-panel');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement.dataset.font, 'aleo');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  dom.window.close();
});

test('outside click closes the dialog without stealing focus', () => {
  const dom = setup();
  const { document } = dom.window;
  document.querySelector('.lcfs-btn').click();
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  outside.focus();
  outside.click();
  assert.equal(document.querySelector('.lcfs-panel').hidden, true);
  assert.equal(document.activeElement, outside);
  dom.window.close();
});

test('settings remain usable when storage is denied', () => {
  const dom = setup(true);
  const { document } = dom.window;
  const button = document.querySelector('.lcfs-btn');
  assert.ok(button);
  button.click();
  document.querySelector('[data-font="georgia"]').click();
  assert.match(document.documentElement.style.getPropertyValue('--app-font'), /Georgia/);
  button.click();
  button.click();
  assert.equal(document.querySelector('[data-font="georgia"]').getAttribute('aria-pressed'), 'true');
  dom.window.close();
});

test('failed quota writes do not resurrect older persisted settings', () => {
  const dom = setup(false, (win) => {
    win.localStorage.setItem('lc-font-family', 'aleo');
    win.localStorage.setItem('lc-font-size', '16');
    win.localStorage.setItem('lc-font-hidden', JSON.stringify(['georgia']));
    win.Storage.prototype.setItem = () => { throw new Error('quota exceeded'); };
    win.Storage.prototype.removeItem = () => { throw new Error('storage locked'); };
  });
  const { document } = dom.window;
  const button = document.querySelector('.lcfs-btn');
  button.click();
  document.querySelector('[data-font="optima"]').click();
  document.querySelector('[aria-label="Larger text"]').click();
  document.querySelector('.lcfs-reset').click();
  button.click();
  button.click();
  assert.equal(document.querySelector('[data-font="optima"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('.lcfs-size-val').textContent, '17px');
  assert.ok(document.querySelector('[data-font="georgia"]'));
  dom.window.close();
});

test('malformed saved custom and hidden lists do not prevent mounting', () => {
  for (const value of ['{}', '"oops"', '[null,{"id":"gf-bad"}]']) {
    const dom = setup(false, (win) => {
      win.localStorage.setItem('lc-font-custom', value);
      win.localStorage.setItem('lc-font-hidden', value);
    });
    dom.window.document.querySelector('.lcfs-btn').click();
    assert.ok(dom.window.document.querySelector('[data-font="aleo"]'));
    assert.equal(dom.window.document.querySelectorAll('.lcfs-row').length, 6);
    dom.window.close();
  }
});

test('rerendering after remove and reset keeps focus on a useful control', () => {
  const dom = setup();
  const { document, KeyboardEvent } = dom.window;
  document.querySelector('.lcfs-btn').click();
  document.querySelector('[aria-label="Remove Georgia from list"]').click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Remove Palatino from list');
  document.querySelector('.lcfs-reset').click();
  assert.equal(document.activeElement.className, 'lcfs-add-toggle');
  document.activeElement.click();
  const input = document.querySelector('.lcfs-add-form input');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.activeElement.className, 'lcfs-add-toggle');
  dom.window.close();
});
