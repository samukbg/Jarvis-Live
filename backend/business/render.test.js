import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage, RENDER_LIMITS } from './render.js';

// A fake Playwright: one page whose text is `body`, with `nav` in-app views.
function fakePlaywright({ body, nav = [], viewText = (i) => `view ${i}` }) {
  let current = body;
  const page = {
    on() {},
    async goto() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async click(sel) { current = viewText(Number(sel.match(/"(\d+)"/)[1])); },
    async evaluate(fn) {
      if (fn.name === 'readView') return { title: 'T', headings: [], logos: [], text: current, bodyText: current };
      if (fn.name === 'markNav') return nav;
      return current.length;
    },
  };
  const browser = { async newContext() { return { async newPage() { return page; } }; }, async close() {} };
  return async () => ({ chromium: { async launch() { return browser; } } });
}

const limits = { ...RENDER_LIMITS, quietMs: 0, totalMs: 20_000 };

test('a single-view page keeps its text up to the whole budget', async () => {
  const body = `${'x'.repeat(10_200)} ArtesMusicais`;
  const r = await renderPage('file:///demo.html', { limits, loadPlaywright: fakePlaywright({ body }) });
  assert.ok(r.text.endsWith('ArtesMusicais'));
  assert.equal(r.views.length, 0);
});

test('a page with in-app views keeps room for them', async () => {
  const body = 'y'.repeat(30_000);
  const r = await renderPage('file:///app.html', { limits, loadPlaywright: fakePlaywright({ body, nav: ['Apps', 'Blogs'] }) });
  assert.equal(r.text.length, RENDER_LIMITS.firstViewChars);
  assert.deepEqual(r.views.map((v) => v.label), ['Apps', 'Blogs']);
});
