// Facts from a link: a website (static HTML, rendered in a headless browser when it is a
// single-page app with little text), an API answering JSON, or a PDF / CSV / text file online.
//
// SSRF: the server fetches what a client asked for, so hosts are checked (after DNS) before
// every request and every redirect. Public addresses always; loopback and private LAN only
// when the owner of this computer added the source (`allowPrivate` — the owner can already
// read anything on it; the phone app's Cloud token cannot reach the LAN through it);
// link-local (cloud metadata 169.254.169.254), multicast and "this network" never.
//
// Custom headers (an API's Authorization / admin key) go only to the source's own origin:
// a redirect elsewhere drops them.
import dns from 'node:dns/promises';
import net from 'node:net';
import { formatFromContentType, pdfText, summarizeCsv, summarizeJson, TEXT_CAP } from './formats.js';
import { plainText } from './scanFolder.js';

export const FETCH_LIMITS = { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, maxRedirects: 5, maxSubpages: 3, pageChars: 15_000, renderBelowChars: 400 };
const USER_AGENT = 'Mozilla/5.0 (compatible; JarvisBusiness/1.0; +https://jarvis-live.xyz)';

/** 'public' | 'private' (loopback, LAN, CGNAT, ULA) | 'blocked' (link-local, multicast, unspecified…). */
export function addressClass(ip) {
  let a = String(ip || '').toLowerCase();
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    if (p === 0 || p >= 224 || (p === 169 && q === 254) || (p === 192 && q === 0) || (p === 198 && (q === 18 || q === 19))) return 'blocked';
    if (p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127)) return 'private';
    return 'public';
  }
  if (net.isIPv6(a)) {
    if (a === '::' || /^fe[89ab]/.test(a) || a.startsWith('ff')) return 'blocked';
    if (a === '::1' || /^f[cd]/.test(a)) return 'private';
    return 'public';
  }
  return 'blocked';
}

/** Throws unless every address `hostname` resolves to may be fetched. */
export async function checkHost(hostname, { allowPrivate = false, lookup = dns.lookup } = {}) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('No host');
  const named = !net.isIP(host);
  if (named && !allowPrivate && (host === 'localhost' || /\.(localhost|local|internal|lan|home|intranet)$/.test(host))) {
    throw new Error(`Refused: ${host} is not a public website`);
  }
  const addrs = named ? await lookup(host, { all: true }).catch(() => { throw new Error(`Can't find ${host}`); }) : [{ address: host }];
  for (const { address } of addrs) {
    const cls = addressClass(address);
    if (cls === 'blocked' || (cls === 'private' && !allowPrivate)) throw new Error(`Refused: ${host} is not a public address`);
  }
}

/**
 * GET with manual redirects (each hop checked), a timeout and a size cap. `headers` are sent
 * only while on the first URL's origin. Returns { url, status, contentType, body }.
 */
export async function fetchLimited(url, { headers = {}, allowPrivate = false, limits = FETCH_LIMITS, fetchImpl = fetch, lookup } = {}) {
  const origin = new URL(url).origin;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let current = url;
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) links');
    await checkHost(u.hostname, { allowPrivate, lookup });
    const own = u.origin === origin ? headers : {};
    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...own },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      try { await res.body?.cancel?.(); } catch { /* already closed */ }
      continue;
    }
    const chunks = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > limits.maxBytes) {
          chunks.push(Buffer.from(chunk).subarray(0, chunk.length - (size - limits.maxBytes)));
          break; // the first 2 MB are plenty for an overview
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    return { url: current, status: res.status, contentType: res.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  }
  throw new Error('Too many redirects');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', euro: '€', pound: '£', copy: '©' };
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

const PRICE = /(?:[$€£]\s?\d{1,5}(?:[.,]\d{2})?|\d{1,5}(?:[.,]\d{2})?\s?(?:€|EUR|USD))(?:\s?\/\s?(?:mo|month|yr|year|mois|mês|an))?/gi;

/** <img> tags that say they are a logo / icon (alt, class or file name): [{ alt, src }] (absolute http(s)). */
export function logoImages(html, abs) {
  const out = [];
  for (const m of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const src = a.src ? abs(a.src) : null;
    if (!src || !/^https?:/i.test(src) || !/logo|icon/i.test(`${a.alt || ''} ${a.class || ''} ${a.src}`)) continue;
    if (!out.some((l) => l.src === src)) out.push({ alt: (a.alt || '').trim(), src });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * The readable parts of an HTML page (a pure function: tested on sample HTML). Script, style,
 * nav and footer content is left out of the text.
 */
export function extractHtml(html, baseUrl, { maxChars = FETCH_LIMITS.pageChars } = {}) {
  const src = String(html || '');
  const base = new URL(baseUrl);
  const abs = (href) => { try { return new URL(href, base).toString(); } catch { return null; } };
  const metas = [...src.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const meta = (key) => metas.find((m) => (m.name || m.property || '').toLowerCase() === key)?.content?.trim() || undefined;
  const iconLink = [...src.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]))
    .find((l) => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(l.rel || '') && l.href);

  const body = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|nav|footer|iframe|canvas)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const headings = [...body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)].map((m) => stripTags(m[2])).filter(Boolean).slice(0, 40);
  const text = decodeEntities(
    body
      .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, maxChars);

  const links = [];
  for (const m of src.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attrs(m[0].slice(0, m[0].indexOf('>') + 1)).href;
    const u = href && abs(href);
    if (!u) continue;
    const url = new URL(u);
    if (url.origin !== base.origin) continue;
    url.hash = '';
    links.push({ url: url.toString(), label: stripTags(m[1]).slice(0, 60) });
  }

  return {
    url: base.toString(),
    title: stripTags(src.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]) || undefined,
    description: meta('description') || meta('og:description'),
    siteName: meta('og:site_name'),
    image: meta('og:image') ? abs(meta('og:image')) : undefined,
    favicon: abs(iconLink?.href || '/favicon.ico'),
    headings,
    logos: logoImages(src, abs),
    text,
    prices: [...new Set(text.match(PRICE) || [])].slice(0, 8),
    links: [...new Map(links.map((l) => [l.url, l])).values()],
  };
}

const SUBPAGE = /\/(about|pricing|prices|plans|product|products|features|team|company|blog|services|solutions|customers)(\/|$|\.)/i;

/** Up to `max` same-origin pages worth reading next (about, pricing, product…). */
export function pickSubpages(page, max = FETCH_LIMITS.maxSubpages) {
  const self = page.url.replace(/\/+$/, '');
  return page.links.map((l) => l.url).filter((u) => u.replace(/\/+$/, '') !== self && SUBPAGE.test(new URL(u).pathname)).slice(0, max);
}

/**
 * Facts from a link. `render` (render.js renderPage) turns a JS-only page into text.
 * Returns { source: 'website', format, location, name, texts, site?, views? }.
 */
export async function scanUrl(url, { headers = {}, allowPrivate = false, limits = FETCH_LIMITS, fetchImpl, lookup, render } = {}) {
  const res = await fetchLimited(url, { headers, allowPrivate, limits, fetchImpl, lookup });
  if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}: the link needs access (add its auth header)`);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} from ${new URL(res.url).host}`);
  const format = formatFromContentType(res.contentType, res.body);
  if (!format) throw new Error('Unsupported content type');
  const host = new URL(res.url).hostname.replace(/^www\./, '');
  const facts = { source: 'website', format, location: url, name: host, hasCode: false, texts: [] };
  const utf8 = () => res.body.toString('utf8');

  if (format === 'api') {
    let json;
    try { json = JSON.parse(utf8()); } catch { throw new Error('The link answered invalid JSON'); }
    facts.texts.push({ label: 'API response', text: summarizeJson(json) });
    return facts;
  }
  if (format === 'pdf') {
    const { text, pages } = await pdfText(res.body);
    facts.pages = pages;
    facts.texts.push({ label: `PDF (${pages} pages)`, text });
    return facts;
  }
  if (format === 'csv') { facts.texts.push({ label: 'CSV', text: summarizeCsv(utf8()) }); return facts; }
  if (format === 'text' || format === 'markdown') { facts.texts.push({ label: 'Text', text: plainText(utf8()).slice(0, TEXT_CAP) }); return facts; }

  // A web page: its text and a few pages about the business (about, pricing, product…).
  const page = extractHtml(utf8(), res.url, { maxChars: limits.pageChars });
  facts.name = page.siteName || page.title?.split(/\s[|–—-]\s/)[0]?.trim() || host;
  facts.site = { title: page.title, description: page.description, siteName: page.siteName, image: page.image, favicon: page.favicon, headings: page.headings, prices: page.prices, logos: page.logos, pages: [{ url: page.url, title: page.title }] };
  if (page.text.length < limits.renderBelowChars && render) {
    // Little text in the HTML: a single-page app. Its scripts render the content.
    try {
      const r = await render(res.url);
      facts.format = 'web';
      facts.rendered = true;
      facts.site.headings = r.headings.length ? r.headings : page.headings;
      if (r.logos?.length) facts.site.logos = r.logos;
      facts.texts.push({ label: 'Page (rendered)', text: r.text });
      facts.views = r.views;
      return facts;
    } catch (e) {
      facts.renderError = e.message;
    }
  }
  facts.texts.push({ label: 'Home page', text: page.text });
  for (const sub of pickSubpages(page, limits.maxSubpages)) {
    try {
      const r = await fetchLimited(sub, { headers, allowPrivate, limits, fetchImpl, lookup });
      if (r.status >= 400 || formatFromContentType(r.contentType, r.body) !== 'web') continue;
      const p = extractHtml(r.body.toString('utf8'), r.url, { maxChars: 5_000 });
      facts.site.pages.push({ url: p.url, title: p.title });
      facts.site.prices = [...new Set([...facts.site.prices, ...p.prices])].slice(0, 8);
      facts.texts.push({ label: `Page ${new URL(p.url).pathname}`, text: p.text });
    } catch {
      // a subpage that fails is just left out
    }
  }
  return facts;
}
