// JS-rendered pages (an admin dashboard whose index.html is an empty shell, a single-page
// website): open them in a headless browser so their scripts run and fetch their data, then
// read the visible text — of the default view and, when the page has in-app navigation (a
// sidebar of per-app views), of each view too.
//
// The system's Chrome first (installed on most computers, nothing to download), else
// Playwright's own Chromium when it is there. No persistent profile, always closed. Only the
// visible text leaves this module: never the page's source or its scripts (a dashboard's
// config.js holds its admin API key).

export const RENDER_LIMITS = {
  totalMs: 60_000, // the whole render, views included
  settleMs: 30_000, // first view: the page's own fetches may take 30 s
  quietMs: 1_500, // text unchanged this long = the data is in
  maxViews: 10,
  viewMs: 5_000,
  firstViewChars: 10_000,
  viewChars: 3_000,
  maxChars: 25_000,
};

async function launch(chromium) {
  const errors = [];
  for (const options of [{ channel: 'chrome' }, {}]) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (e) {
      errors.push(e.message.split('\n')[0]);
    }
  }
  throw new Error(`No browser to render the page (${errors.join('; ')})`);
}

/** Polls the page's visible text until it stops changing (or `maxMs` passes). */
async function waitForStableText(page, { quietMs, maxMs }) {
  const end = Date.now() + maxMs;
  let last = -1;
  let since = Date.now();
  while (Date.now() < end) {
    const len = await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => -1);
    if (len !== last) { last = len; since = Date.now(); } else if (Date.now() - since >= quietMs && len > 0) return;
    await page.waitForTimeout(400);
  }
}

/** Runs in the page: the main content's visible text, headings and the in-app nav entries. */
function readView() {
  const main = document.querySelector('main, [role="main"], #content, #main, .content') || document.body;
  const headings = [...document.querySelectorAll('h1, h2, h3')].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 40);
  return { title: document.title || '', headings, text: (main?.innerText || '').trim(), bodyText: (document.body?.innerText || '').trim() };
}

/** Runs in the page: tags the in-app navigation entries (same-page links / buttons) and returns their labels. */
function markNav(max) {
  const roots = document.querySelectorAll('nav, [role="navigation"], aside, .sidebar, .nav');
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll('a, button, [role="tab"], [role="menuitem"]')) {
      if (out.length >= max) break;
      const label = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      if (!label || label.length > 60 || seen.has(label)) continue;
      const href = el.getAttribute('href');
      // Only in-app views: hash routes, same-page buttons. Not external links or downloads.
      if (href && !href.startsWith('#') && !href.startsWith('?')) {
        try {
          const u = new URL(href, location.href);
          if (u.origin !== location.origin || u.pathname !== location.pathname) continue;
        } catch { continue; }
      }
      if (el.hasAttribute('download') || el.getAttribute('target') === '_blank') continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      seen.add(label);
      el.setAttribute('data-jarvis-nav', String(out.length));
      out.push(label);
    }
  }
  return out;
}

/**
 * Renders `url` (file:// or http(s)) and returns { title, headings, text, views: [{ label, text }] }.
 * Throws when no browser can be started or the page does not load.
 */
export async function renderPage(url, { limits = RENDER_LIMITS, loadPlaywright = () => import('playwright-core') } = {}) {
  const started = Date.now();
  const left = () => limits.totalMs - (Date.now() - started);
  const { chromium } = await loadPlaywright();
  const browser = await launch(chromium);
  try {
    const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('popup', (p) => p.close().catch(() => {}));
    await page.goto(url, { waitUntil: 'load', timeout: Math.min(20_000, left()) });
    await page.waitForLoadState('networkidle', { timeout: Math.min(limits.settleMs, left()) }).catch(() => {});
    await waitForStableText(page, { quietMs: limits.quietMs, maxMs: Math.min(10_000, Math.max(0, left() - 1_000)) });

    const first = await page.evaluate(readView);
    // A sidebar holds the business names: keep the whole page's text for the default view.
    const firstText = (first.bodyText || first.text).slice(0, limits.firstViewChars);
    const result = { title: first.title, headings: first.headings, text: firstText, views: [] };
    let used = firstText.length;

    const labels = await page.evaluate(markNav, limits.maxViews).catch(() => []);
    for (let i = 0; i < labels.length; i++) {
      if (left() < limits.viewMs + 1_000 || used >= limits.maxChars) break;
      try {
        await page.click(`[data-jarvis-nav="${i}"]`, { timeout: 2_000 });
        await page.waitForLoadState('networkidle', { timeout: limits.viewMs }).catch(() => {});
        await waitForStableText(page, { quietMs: 800, maxMs: limits.viewMs });
        const view = await page.evaluate(readView);
        const text = view.text.slice(0, Math.min(limits.viewChars, limits.maxChars - used));
        if (!text || text.slice(0, 500) === first.text.slice(0, 500)) continue; // the default view again
        result.views.push({ label: labels[i], text });
        used += text.length;
        for (const h of view.headings) if (!result.headings.includes(h) && result.headings.length < 60) result.headings.push(h);
      } catch {
        // A view that does not open is skipped; the others still count.
      }
    }
    result.elapsedMs = Date.now() - started;
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}
