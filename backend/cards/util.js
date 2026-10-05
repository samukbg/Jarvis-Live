// Shared helpers for card enrichment: cached JSON fetches and fuzzy name matching.

const UA = 'Mozilla/5.0 (Jarvis card enrichment)';

export async function getJson(url, { timeoutMs = 8000, headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const cache = new Map();

/** Memoises `fn()` under `key` for `ttlMs`; failures are not cached. */
export function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = Promise.resolve().then(fn);
  cache.set(key, { promise, expires: Date.now() + ttlMs });
  promise.catch(() => cache.delete(key));
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return promise;
}

export const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(['the', 'a', 'an', 'fc', 'cf', 'sc', 'ac', 'afc', 'club', 'de', 'la', 'le', 'feat', 'ft', 'with', 'and', 'remastered', 'remaster', 'version']);
const tokens = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t));

/** True when two names clearly refer to the same thing ("Man City" ≈ "Manchester City" is NOT assumed). */
export function sameName(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (!ta.length || !tb.size) return false;
  const shared = ta.filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.length, tb.size) >= 0.6;
}

/** Drops undefined / null / NaN values (and empty arrays) so the client can merge safely. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export const round = (n, d = 0) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : undefined);

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export const compactNumber = (n) =>
  Number.isFinite(n) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n) : undefined;
