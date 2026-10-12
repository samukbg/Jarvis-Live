// Business logos: each business's own icon, fetched from its website (the <link rel="icon"> /
// apple-touch-icon its pages declare, else /favicon.ico) and kept in the data dir, so the apps
// load it from this server (GET /api/business/logo/:host) instead of every device asking the
// site. Bitmaps first: the phone app can't draw SVG.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attrs, fetchLimited, FETCH_LIMITS } from './scanWebsite.js';

const MAX_BYTES = 512 * 1024;
const FRESH_MS = 7 * 24 * 3600 * 1000; // a logo is re-fetched weekly
const EXT = { 'image/png': 'png', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
export const LOGO_TYPES = { png: 'image/png', ico: 'image/x-icon', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

/** "https://www.spreadout.ai/x" / "spreadout.ai" → "spreadout.ai" (null: not a public-looking host). */
export function hostOf(site) {
  if (!site || typeof site !== 'string') return null;
  try {
    const u = new URL(/^https?:\/\//i.test(site.trim()) ? site.trim() : `https://${site.trim()}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** The icon candidates a page declares, best first (apple-touch-icon / big PNG, then any, SVG last). */
export function iconCandidates(html, baseUrl) {
  const out = [];
  for (const m of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    const l = attrs(m[0]);
    const rel = String(l.rel || '').toLowerCase();
    if (!l.href || !/(^|\s)(icon|shortcut icon|apple-touch-icon(-precomposed)?|mask-icon)(\s|$)/.test(rel) || /mask-icon/.test(rel)) continue;
    let href;
    try { href = new URL(l.href, baseUrl).toString(); } catch { continue; }
    const size = Math.max(0, ...String(l.sizes || '').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
    const svg = /\.svg(\?|$)/i.test(href) || /svg/i.test(l.type || '') || /^data:image\/svg/i.test(href);
    const score = (svg ? -1000 : 0) + (/apple-touch-icon/.test(rel) ? 500 : 0) + Math.min(size, 512) + (/\.png(\?|$)/i.test(href) ? 50 : 0);
    out.push({ href, score });
  }
  out.sort((a, b) => b.score - a.score);
  return [...new Set(out.map((c) => c.href))];
}

/** A data: URL → { status, contentType, body } (null if malformed). */
export function dataUrl(href) {
  const m = /^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(href);
  if (!m) return null;
  try {
    const body = m[3] ? Buffer.from(m[4], 'base64') : Buffer.from(decodeURIComponent(m[4]), 'utf8');
    return { status: 200, contentType: m[1] || 'text/plain', body };
  } catch {
    return null;
  }
}

/** The image type of `body` from its bytes (servers often send ICOs as octet-stream). */
export function sniffImage(body, declared = '') {
  const b = body || Buffer.alloc(0);
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length >= 4 && b.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  const type = String(declared).split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml' && /<svg[\s>]/i.test(b.toString('utf8', 0, 2048))) return 'image/svg+xml';
  return null;
}

const dirOf = (dataDir) => path.join(dataDir, 'business-logos');
const metaPath = (dataDir) => path.join(dirOf(dataDir), 'index.json');
function readMeta(dataDir) {
  try { return JSON.parse(fs.readFileSync(metaPath(dataDir), 'utf8')); } catch { return {}; }
}
function writeMeta(dataDir, meta) {
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  const tmp = `${metaPath(dataDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaPath(dataDir));
}

/** The cached logo file of `host`: { file, type } or null. */
export function logoFile(dataDir, host) {
  if (!/^[a-z0-9.-]+$/.test(String(host || ''))) return null;
  const entry = readMeta(dataDir)[host];
  if (!entry?.ext) return null;
  const file = path.join(dirOf(dataDir), `${host}.${entry.ext}`);
  return fs.existsSync(file) ? { file, type: LOGO_TYPES[entry.ext] || 'application/octet-stream' } : null;
}

/** The app path of a cached logo; `?type=svg` tells the phone app to draw it as SVG. */
const logoPath = (host, ext) => `/api/business/logo/${host}${ext === 'svg' ? '?type=svg' : ''}`;

/** Fetches (or reuses) `host`'s logo → its app path ("/api/business/logo/<host>[?type=svg]") or undefined. */
export async function ensureLogo(dataDir, host, { fetchImpl, lookup, now = Date.now(), log = () => {} } = {}) {
  const meta = readMeta(dataDir);
  const entry = meta[host];
  if (entry?.ext && now - entry.at < FRESH_MS && logoFile(dataDir, host)) return logoPath(host, entry.ext);
  // A site without one is asked again at the next analysis (they only run when the user adds
  // or refreshes a source).
  const limits = { ...FETCH_LIMITS, timeoutMs: 10_000, maxBytes: MAX_BYTES };
  let candidates = [];
  try {
    const page = await fetchLimited(`https://${host}/`, { limits, fetchImpl, lookup });
    if (page.status < 400) candidates = iconCandidates(page.body.toString('utf8'), page.url);
  } catch (e) {
    log(`[BUSINESS] ${host}: home page unavailable for its logo (${e.message})`);
  }
  candidates.push(`https://${host}/favicon.ico`);
  for (const href of [...new Set(candidates)].slice(0, 5)) {
    try {
      // An icon inlined in the page (data: URL) is used as it is.
      const res = href.startsWith('data:') ? dataUrl(href) : await fetchLimited(href, { limits, fetchImpl, lookup });
      if (!res) continue;
      const type = res.status < 400 ? sniffImage(res.body, res.contentType) : null;
      if (!type || res.body.length < 64 || res.body.length >= MAX_BYTES) continue;
      const ext = EXT[type];
      fs.mkdirSync(dirOf(dataDir), { recursive: true });
      for (const old of Object.keys(LOGO_TYPES)) fs.rmSync(path.join(dirOf(dataDir), `${host}.${old}`), { force: true });
      fs.writeFileSync(path.join(dirOf(dataDir), `${host}.${ext}`), res.body);
      writeMeta(dataDir, { ...readMeta(dataDir), [host]: { ext, at: now, from: href.startsWith('data:') ? 'inline icon' : href } });
      return logoPath(host, ext);
    } catch { /* next candidate */ }
  }
  writeMeta(dataDir, { ...readMeta(dataDir), [host]: { at: now } });
  return undefined;
}

/**
 * A logo given as an image URL (the source shows it): cached under "<host>-<hash>" like a
 * website's icon → its app path, or undefined.
 */
export async function ensureLogoImage(dataDir, imageUrl, { fetchImpl, lookup, now = Date.now(), log = () => {} } = {}) {
  const host = hostOf(imageUrl);
  if (!host) return undefined;
  const key = `${host}-${crypto.createHash('sha1').update(imageUrl).digest('hex').slice(0, 10)}`;
  const entry = readMeta(dataDir)[key];
  if (entry?.ext && now - entry.at < FRESH_MS && logoFile(dataDir, key)) return logoPath(key, entry.ext);
  try {
    const res = await fetchLimited(imageUrl, { limits: { ...FETCH_LIMITS, timeoutMs: 10_000, maxBytes: MAX_BYTES }, fetchImpl, lookup });
    const type = res.status < 400 ? sniffImage(res.body, res.contentType) : null;
    if (type && res.body.length >= 64 && res.body.length < MAX_BYTES) {
      const ext = EXT[type];
      fs.mkdirSync(dirOf(dataDir), { recursive: true });
      fs.writeFileSync(path.join(dirOf(dataDir), `${key}.${ext}`), res.body);
      writeMeta(dataDir, { ...readMeta(dataDir), [key]: { ext, at: now, from: imageUrl } });
      return logoPath(key, ext);
    }
  } catch (e) {
    log(`[BUSINESS] logo image ${host} unavailable (${e.message})`);
  }
  writeMeta(dataDir, { ...readMeta(dataDir), [key]: { at: now } });
  return undefined;
}

/**
 * Sets `logoUrl` on each overview whose business has a website (its `website`, else the source's
 * own link): the cached icon's app path. Overviews without one keep their monogram.
 */
export async function attachLogos(overviews, { dataDir, fetchImpl, lookup, log } = {}) {
  for (const o of overviews.filter(Boolean)) {
    // A logo image the source itself shows for this business comes first (e.g. a plugin's icon).
    if (o.logo) {
      const url = await ensureLogoImage(dataDir, o.logo, { fetchImpl, lookup, log }).catch(() => undefined);
      if (url) { o.logoUrl = url; continue; }
    }
    const host = hostOf(o.website) || (o.source === 'website' ? hostOf(o.location) : null);
    if (!host) continue;
    try {
      const url = await ensureLogo(dataDir, host, { fetchImpl, lookup, log });
      if (url) o.logoUrl = url;
      else if (o.logoUrl?.startsWith('/api/business/logo/')) delete o.logoUrl;
    } catch (e) {
      log?.(`[BUSINESS] ${host}: logo failed (${e.message})`);
    }
  }
  return overviews;
}
