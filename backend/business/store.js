// Settings → Businesses: the folders, files and websites the user asked Jarvis to keep an eye
// on, with the overview built from each (business-sources.json in the data dir).
//
// One JSON file, kept in memory and rewritten atomically (temp file + rename): a crash while
// writing must not lose the list. It can hold an API's auth headers, so it is written 0600 and
// header values never leave this module's callers: clients see `headerNames` only (publicView).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SOURCES_FILE = 'business-sources.json';
export const SOURCE_KINDS = ['folder', 'website'];

/** `~/x` → the home folder's x (paths typed in Settings). */
export function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/**
 * The comparable form of a target, for duplicates: an absolute path without a trailing
 * separator, or a URL with a lowercase host, no hash and no trailing slash. Throws on
 * something that is neither.
 */
export function normalizeTarget(kind, target) {
  const raw = String(target ?? '').trim();
  if (!raw) throw new Error('Target required');
  if (kind === 'folder') {
    const abs = path.resolve(expandHome(raw));
    const root = path.parse(abs).root;
    return abs.length > root.length ? abs.replace(/[\\/]+$/, '') : abs;
  }
  if (kind === 'website') {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) websites');
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/+$/, '');
  }
  throw new Error(`kind must be ${SOURCE_KINDS.join(' or ')}`);
}

/** A readable default name: the folder or file name, or the website's host. */
export function defaultName(kind, target) {
  if (kind === 'website') return new URL(target).hostname.replace(/^www\./, '');
  return path.basename(target).replace(/\.(html?|md|markdown|txt)$/i, '') || target;
}

/** Auth headers for a link: ≤ 5, token-like names, values ≤ 2 KB. Throws on anything else. */
export function validateHeaders(headers) {
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers !== 'object' || Array.isArray(headers)) throw new Error('headers must be an object');
  const entries = Object.entries(headers);
  if (entries.length > 5) throw new Error('At most 5 headers');
  const out = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(k)) throw new Error(`Invalid header name: ${k.slice(0, 64)}`);
    if (/^(host|content-length|connection|transfer-encoding|cookie2?)$/i.test(k)) throw new Error(`Header not allowed: ${k}`);
    const value = String(v ?? '');
    if (value.length > 2048 || /[\r\n]/.test(value)) throw new Error(`Invalid value for header ${k}`);
    out[k] = value;
  }
  return entries.length ? out : undefined;
}

/** A source as clients see it: header values replaced by their names. */
export function publicView(source) {
  if (!source) return source;
  const { headers, ...rest } = source;
  return headers && Object.keys(headers).length ? { ...rest, headerNames: Object.keys(headers) } : rest;
}

export class DuplicateSourceError extends Error {
  constructor(source) {
    super('This source is already added');
    this.code = 'duplicate';
    this.source = source;
  }
}

export function createBusinessStore({ dataDir, now = () => new Date() }) {
  const file = path.join(dataDir, SOURCES_FILE);
  let sources = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) sources = parsed.filter((s) => s && s.id && SOURCE_KINDS.includes(s.kind));
  } catch {
    // First run (no file) or a damaged one: start empty rather than refuse to boot.
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sources, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows: no POSIX modes */ }
  }

  const find = (id) => sources.find((s) => s.id === id) || null;

  return {
    file,
    list: () => sources.map((s) => ({ ...s })),
    get: (id) => (find(id) ? { ...find(id) } : null),

    /** Adds a source in 'analysing' state; DuplicateSourceError when the same target is there. */
    add({ kind, target, name, format, headers, allowPrivate }) {
      const normalized = normalizeTarget(kind, target);
      const dup = sources.find((s) => s.kind === kind && normalizeTarget(s.kind, s.target) === normalized);
      if (dup) throw new DuplicateSourceError({ ...dup });
      const source = {
        id: `b${crypto.randomBytes(5).toString('hex')}`,
        kind,
        target: normalized,
        name: String(name || '').trim().slice(0, 80) || defaultName(kind, normalized),
        ...(String(name || '').trim() ? {} : { nameAuto: true }),
        status: 'analysing',
        addedAt: now().toISOString(),
        ...(format ? { format } : {}),
        ...(headers ? { headers } : {}),
        ...(allowPrivate ? { allowPrivate: true } : {}),
      };
      sources.push(source);
      save();
      return { ...source };
    },

    /** Merges `patch` into a source (null values remove the field). */
    update(id, patch) {
      const s = find(id);
      if (!s) return null;
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete s[k];
        else s[k] = v;
      }
      save();
      return { ...s };
    },

    remove(id) {
      const before = sources.length;
      sources = sources.filter((s) => s.id !== id);
      if (sources.length === before) return false;
      save();
      return true;
    },
  };
}
