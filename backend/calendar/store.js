// Settings → Calendar on disk (the server's data dir):
//   calendar-accounts.json  the connected accounts with their credentials (Google refresh token,
//                           CalDAV app password, a feed's secret link) and the settings — 0600,
//                           rewritten atomically (temp file + rename)
//   calendar-cache.json     the last synced events of each account, so a restart answers at once
//   calendar-files/<id>.ics an imported file, as uploaded
// Credentials never leave this module's callers: the apps see publicView().
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidZone, systemZone } from './tz.js';

export const ACCOUNTS_FILE = 'calendar-accounts.json';
export const CACHE_FILE = 'calendar-cache.json';
export const FILES_DIR = 'calendar-files';
export const ACCOUNT_KINDS = ['google', 'caldav', 'ics', 'file', 'device'];

function writeAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch { /* Windows */ }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** A link with its secret parts hidden: 'calendar.google.com/…/basic.ics'. */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return `${u.hostname}${last ? `/…/${last.length > 24 ? `${last.slice(0, 8)}…` : last}` : ''}`;
  } catch {
    return 'a link';
  }
}

/** An account as the apps see it: no credentials, no cached objects. */
export function publicView(account, cached) {
  if (!account) return account;
  const { credentials, objects, url, ...rest } = account;
  const calendars = (account.calendars || []).map(({ id, name, color, enabled, writable, primary }) => ({
    id, name, ...(color ? { color } : {}), enabled: enabled !== false, writable: !!writable, ...(primary ? { primary: true } : {}),
  }));
  return {
    ...rest,
    calendars,
    writable: calendars.some((c) => c.enabled && c.writable),
    ...(cached ? { eventCount: cached.events?.length || 0 } : {}),
  };
}

export function createCalendarStore({ dataDir }) {
  const file = path.join(dataDir, ACCOUNTS_FILE);
  const cacheFile = path.join(dataDir, CACHE_FILE);
  const filesDir = path.join(dataDir, FILES_DIR);
  const loaded = readJson(file, {});
  let accounts = Array.isArray(loaded.accounts) ? loaded.accounts.filter((a) => a && ACCOUNT_KINDS.includes(a.kind)) : [];
  let settings = { defaultCalendar: null, timeZone: null, ...(loaded.settings || {}) };
  const cacheLoaded = readJson(cacheFile, {});
  const cache = new Map(Object.entries(cacheLoaded && typeof cacheLoaded === 'object' ? cacheLoaded : {}));
  // Accounts that were syncing when the server stopped: synced again at start.
  for (const a of accounts) if (a.status === 'syncing') a.status = cache.has(a.id) ? 'ready' : 'error';

  const save = () => writeAtomic(file, JSON.stringify({ accounts, settings }, null, 2));
  let cacheTimer = null;
  const saveCache = () => {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      try { writeAtomic(cacheFile, JSON.stringify(Object.fromEntries(cache))); } catch { /* next time */ }
    }, 1500);
    cacheTimer.unref?.();
  };

  return {
    list: () => accounts.map((a) => ({ ...a })),
    get: (id) => {
      const a = accounts.find((x) => x.id === id);
      return a ? { ...a } : null;
    },
    add(fields) {
      const account = { id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), status: 'syncing', calendars: [], ...fields };
      accounts.push(account);
      save();
      return { ...account };
    },
    update(id, patch) {
      const i = accounts.findIndex((x) => x.id === id);
      if (i < 0) return null;
      accounts[i] = { ...accounts[i], ...patch };
      save();
      return { ...accounts[i] };
    },
    remove(id) {
      const before = accounts.length;
      accounts = accounts.filter((x) => x.id !== id);
      if (accounts.length === before) return false;
      if (settings.defaultCalendar?.accountId === id) settings = { ...settings, defaultCalendar: null };
      save();
      cache.delete(id);
      saveCache();
      try { fs.rmSync(path.join(filesDir, `${id}.ics`)); } catch { /* none */ }
      return true;
    },
    settings: () => ({ defaultCalendar: settings.defaultCalendar || null, timeZone: isValidZone(settings.timeZone) ? settings.timeZone : systemZone(), shareWithVoice: settings.shareWithVoice !== false }),
    /** The zone the user set (null: the computer's). */
    ownZone: () => (isValidZone(settings.timeZone) ? settings.timeZone : null),
    setSettings(patch) {
      settings = { ...settings, ...patch };
      save();
      return this.settings();
    },
    cached: (id) => cache.get(id) || null,
    setCached(id, value) {
      cache.set(id, value);
      saveCache();
    },
    fileOf: (id) => path.join(filesDir, `${id}.ics`),
    writeFile(id, text) {
      writeAtomic(path.join(filesDir, `${id}.ics`), text);
    },
    readFile(id) {
      try {
        return fs.readFileSync(path.join(filesDir, `${id}.ics`), 'utf8');
      } catch {
        return null;
      }
    },
  };
}
