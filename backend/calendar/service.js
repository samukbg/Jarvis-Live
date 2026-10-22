// Settings → Calendar behind the routes and the voice tools: connect accounts (Google, CalDAV,
// links, files, the phone's calendars), keep their events synced (every 15 min, 30 days back …
// 180 days ahead, cached on disk), answer agenda questions, add / move / delete events, and show
// the agenda card.
//
// The apps hear `calendar_accounts` (the list, for Settings) whenever an account changes.
import { CALENDAR_TOOLS, ADD_EVENT_TOOL, AGENDA_TOOL, DELETE_EVENT_TOOL, UPDATE_EVENT_TOOL, agendaData, agendaDigest, agendaText, calendarPrompt, resolveRange, spokenAgenda, timeLabel } from './card.js';
import { emailOfIdToken, createGoogleAuth } from './googleAuth.js';
import { createCaldav, PROVIDERS } from './providers/caldav.js';
import { connectFeed, downloadFeed, eventsOfText, readFile } from './providers/feed.js';
import { createGoogle } from './providers/google.js';
import { createCalendarStore, publicView } from './store.js';
import crypto from 'node:crypto';
import { addDays, dateInZone, isValidZone, isoInZone, parseWhen, startOfDay } from './tz.js';

export const SYNC_EVERY_MS = 15 * 60_000;
export const WINDOW_BACK_DAYS = 30;
export const WINDOW_AHEAD_DAYS = 180;
export const MAX_DEVICE_EVENTS = 2000;
export const ORIGINS = ['iphone', 'android', 'watch', 'web'];
const DAY = 86400_000;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export function createCalendarService({
  dataDir,
  broadcast = () => {},
  log = () => {},
  env = process.env,
  port = 4000,
  cloud = () => null,
  phoneAction = null,
  fetchImpl = fetch,
  lookup,
  now = Date.now,
  google: googleImpl,
  caldav: caldavImpl,
  googleUnavailableReason,
} = {}) {
  const store = createCalendarStore({ dataDir });
  const syncing = new Map(); // accountId → Promise
  const refs = new Map(); // 'e3' → { accountId, calendarId, eventId }
  const refOfKey = new Map();
  let refSeq = 0;
  const agentTokens = new Map(); // token → expiry (agentBrief)
  // The next 7 days for the voice models' context (calendarPrompt), rebuilt after every change.
  let digest = null;
  let digestTimer = null;
  const refreshDigest = () => {
    clearTimeout(digestTimer);
    digestTimer = setTimeout(async () => {
      try {
        if (!store.list().length) { digest = null; return; }
        const zone = tz();
        const fromMs = startOfDay(dateInZone(now(), zone), zone);
        digest = agendaDigest((await collect({ fromMs, toMs: fromMs + 7 * DAY })).map(strip), { tz: zone, now: now() });
      } catch (e) {
        log(`[calendar] agenda digest: ${e.message}`);
      }
    }, 300);
    digestTimer.unref?.();
  };
  let timer = null;

  const tz = () => store.settings().timeZone;
  const windowNow = () => ({ fromMs: now() - WINDOW_BACK_DAYS * DAY, toMs: now() + WINDOW_AHEAD_DAYS * DAY });
  const view = (a) => publicView(a, store.cached(a.id));
  const accounts = () => store.list().map(view);
  const announce = () => broadcast({ type: 'calendar_accounts', accounts: accounts() });

  // --- Google tokens -------------------------------------------------------------------------
  const googleAuth = createGoogleAuth({
    cloud, env, port, fetchImpl, log,
    ...(googleUnavailableReason ? { unavailableReason: googleUnavailableReason } : {}),
    onTokens: (tokens) => addGoogle(tokens),
  });
  async function accessToken(account, force = false) {
    const c = account.credentials || {};
    if (!force && c.accessToken && c.expiresAt && c.expiresAt - 60_000 > now()) return c.accessToken;
    try {
      const t = await googleAuth.refresh(c.refreshToken, c.via);
      const credentials = { ...c, accessToken: t.access_token, expiresAt: now() + (Number(t.expires_in) || 3600) * 1000 };
      store.update(account.id, { credentials });
      account.credentials = credentials;
      return t.access_token;
    } catch (e) {
      if (e.code === 'invalid_grant') {
        store.update(account.id, { status: 'needs_auth', error: 'Google access was removed — connect this account again' });
        announce();
      }
      throw e;
    }
  }
  const google = googleImpl || createGoogle({ token: (a) => accessToken(a), retryToken: (a) => accessToken(a, true), fetchImpl });
  const caldav = caldavImpl || createCaldav({ lookup });

  async function addGoogle(tokens) {
    const email = emailOfIdToken(tokens.id_token);
    const credentials = { refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresAt: now() + (Number(tokens.expires_in) || 3600) * 1000, via: googleAuth.modeFor() };
    // The same Google account again: new tokens, same account (its toggles stay).
    const same = email && store.list().find((a) => a.kind === 'google' && a.email === email);
    let account;
    if (same) {
      await googleAuth.revoke(same.credentials?.refreshToken).catch(() => {});
      account = store.update(same.id, { credentials, status: 'syncing', error: undefined });
    } else {
      account = store.add({ kind: 'google', name: email || 'Google Calendar', email: email || undefined, detail: 'Google Calendar', credentials, status: 'syncing' });
    }
    try {
      account.calendars = await google.calendars(account);
      store.update(account.id, { calendars: account.calendars });
    } catch (e) {
      log(`[calendar] Google calendars: ${e.message}`);
    }
    await sync(account.id);
    log(`[calendar] Google Calendar connected (${account.calendars?.length || 0} calendars)`);
    return view(store.get(account.id));
  }

  // --- Sync ----------------------------------------------------------------------------------
  /** Fetches an account's events in `win` (live, not cached). → { calendars?, events, objects? } */
  async function fetchAccount(account, win) {
    const w = { ...win, tz: tz() };
    switch (account.kind) {
      case 'google': return google.fetch(account, w);
      case 'caldav': return caldav.fetch(account, w);
      case 'ics': {
        const text = await downloadFeed(account.url, { allowPrivate: !!account.allowPrivate, fetchImpl, lookup });
        store.writeFile(account.id, text);
        return { events: eventsOfText(text, account.calendars[0]?.id || 'feed', w) };
      }
      case 'file': {
        const text = store.readFile(account.id);
        if (!text) throw bad('The imported file is missing — import it again', 404);
        return { events: eventsOfText(text, account.calendars[0]?.id || 'file', w) };
      }
      case 'device': {
        const c = store.cached(account.id);
        return { events: (c?.events || []).filter((e) => e.endMs > win.fromMs && e.startMs < win.toMs) };
      }
      default: return { events: [] };
    }
  }

  async function runSync(id) {
    const account = store.get(id);
    if (!account || account.kind === 'device') return account;
    if (account.status === 'needs_auth') return account;
    store.update(id, { status: 'syncing' });
    announce();
    const win = windowNow();
    try {
      const res = await fetchAccount(account, win);
      const current = store.get(id);
      if (!current) return null; // removed meanwhile
      store.setCached(id, { syncedAt: new Date(now()).toISOString(), fromMs: win.fromMs, toMs: win.toMs, events: res.events, ...(res.objects ? { objects: res.objects } : {}) });
      store.update(id, { status: 'ready', error: undefined, lastSync: new Date(now()).toISOString(), ...(res.calendars ? { calendars: res.calendars } : {}) });
    } catch (e) {
      const current = store.get(id);
      if (!current) return null;
      if (current.status !== 'needs_auth') store.update(id, { status: 'error', error: e.message.slice(0, 240) });
      log(`[calendar] ${account.kind} "${account.name}" sync failed: ${e.message}`);
    }
    announce();
    refreshDigest();
    return store.get(id);
  }

  function sync(id) {
    if (!syncing.has(id)) syncing.set(id, runSync(id).finally(() => syncing.delete(id)));
    return syncing.get(id);
  }

  function syncDue() {
    for (const a of store.list()) {
      if (a.kind === 'device' || a.status === 'needs_auth') continue;
      const last = a.lastSync ? Date.parse(a.lastSync) : 0;
      const every = a.status === 'error' ? SYNC_EVERY_MS * 2 : SYNC_EVERY_MS;
      if (now() - last >= every) sync(a.id);
    }
  }

  // --- Events --------------------------------------------------------------------------------
  /** Public CalendarEvent of a cached/fetched one. */
  function publicEvent(account, e) {
    const cal = account.calendars?.find((c) => c.id === e.calendarId);
    const { startMs, endMs, uid, ...rest } = e;
    // A location that is only the meeting link: the card's Join button already has it.
    if (rest.location && /^https?:\/\/\S+$/i.test(rest.location)) {
      rest.meetingUrl = rest.meetingUrl || rest.location;
      delete rest.location;
    }
    return {
      ...rest,
      accountId: account.id,
      ...(cal ? { calendarName: cal.name } : {}),
      ...(cal?.color ? { color: cal.color } : {}),
      writable: !!(e.writable && cal?.writable && account.kind !== 'device' && account.kind !== 'ics' && account.kind !== 'file'),
      _startMs: startMs,
      _endMs: endMs,
    };
  }

  /**
   * Every enabled calendar's events overlapping [fromMs, toMs), deduplicated (the same meeting
   * in Google and on the phone), sorted. Events outside the cached window are fetched live.
   */
  async function collect({ fromMs, toMs, q } = {}) {
    const out = [];
    for (const account of store.list()) {
      const enabled = new Set((account.calendars || []).filter((c) => c.enabled !== false).map((c) => c.id));
      let events;
      const c = store.cached(account.id);
      if (c && fromMs >= c.fromMs && toMs <= c.toMs) events = c.events;
      else if (account.status !== 'needs_auth') {
        try {
          events = (await fetchAccount(account, { fromMs, toMs })).events;
        } catch (e) {
          log(`[calendar] ${account.name}: ${e.message}`);
          events = c?.events || [];
        }
      } else events = c?.events || [];
      for (const e of events || []) {
        if (!enabled.has(e.calendarId)) continue;
        if (!(e.endMs > fromMs || (e.endMs === e.startMs && e.startMs >= fromMs)) || e.startMs >= toMs) continue;
        out.push(publicEvent(account, e));
      }
    }
    const words = q ? norm(q).split(' ').filter(Boolean) : [];
    const matched = words.length ? out.filter((e) => {
      const hay = norm(`${e.title} ${e.location || ''} ${e.description || ''} ${e.calendarName || ''}`);
      return words.every((w) => hay.includes(w));
    }) : out;
    // Dedupe: same title + same times → keep a writable / non-phone copy.
    const rank = (e) => (e.writable ? 0 : 2) + (store.get(e.accountId)?.kind === 'device' ? 1 : 0);
    const best = new Map();
    for (const e of matched) {
      const key = `${norm(e.title)}|${e._startMs}|${e._endMs}`;
      const prev = best.get(key);
      if (!prev || rank(e) < rank(prev)) best.set(key, e);
    }
    return [...best.values()].sort((a, b) => a._startMs - b._startMs || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.title.localeCompare(b.title));
  }

  const strip = (e) => {
    const { _startMs, _endMs, ...rest } = e;
    return rest;
  };

  function refOf(e) {
    const key = `${e.accountId}|${e.calendarId}|${e.id}`;
    if (refOfKey.has(key)) return refOfKey.get(key);
    const ref = `e${++refSeq}`;
    refs.set(ref, { accountId: e.accountId, calendarId: e.calendarId, eventId: e.id });
    refOfKey.set(key, ref);
    if (refs.size > 300) {
      const [oldest] = refs.keys();
      const o = refs.get(oldest);
      refs.delete(oldest);
      refOfKey.delete(`${o.accountId}|${o.calendarId}|${o.eventId}`);
    }
    return ref;
  }

  /** Finds the one event a tool means: a ref ('e3'), or words of its title (yesterday … +90 days). */
  async function findEvent(what) {
    const s = String(what || '').trim();
    if (!s) throw bad('Which event?');
    const r = refs.get(s.replace(/^\[|\]$/g, '').toLowerCase());
    const all = await collect({ fromMs: now() - 2 * DAY, toMs: now() + 90 * DAY });
    if (r) {
      const hit = all.find((e) => e.accountId === r.accountId && e.calendarId === r.calendarId && e.id === r.eventId);
      if (hit) return { event: hit };
    }
    const words = norm(s).split(' ').filter((w) => w.length > 1);
    const matches = all.filter((e) => {
      const t = norm(e.title);
      return words.length && words.every((w) => t.includes(w));
    });
    if (matches.length === 1) return { event: matches[0] };
    if (!matches.length) return { none: true };
    // Several: the next one coming up wins when it's the only future one with that exact title.
    const exact = matches.filter((e) => norm(e.title) === norm(s));
    const upcoming = (exact.length ? exact : matches).filter((e) => e._endMs > now());
    if (upcoming.length >= 1 && new Set(upcoming.map((e) => e.title)).size === 1 && upcoming[0].recurring) return { event: upcoming[0] };
    return { several: matches.slice(0, 6) };
  }

  /** Where new events go: the named calendar, the default, else the first writable (Google's primary first). */
  function targetCalendar(name) {
    const writable = [];
    for (const a of store.list()) {
      if (a.status === 'needs_auth' || !['google', 'caldav'].includes(a.kind)) continue;
      for (const c of a.calendars || []) if (c.writable && c.enabled !== false) writable.push({ account: a, calendar: c });
    }
    if (!writable.length) return null;
    if (name) {
      const n = norm(name);
      const hit = writable.find((w) => norm(w.calendar.name) === n) || writable.find((w) => norm(w.calendar.name).includes(n) || n.includes(norm(w.calendar.name)));
      if (hit) return hit;
    }
    const d = store.settings().defaultCalendar;
    const def = d && writable.find((w) => w.account.id === d.accountId && w.calendar.id === d.calendarId);
    if (def) return def;
    return writable.find((w) => w.calendar.primary) || writable[0];
  }

  /** start/end/duration as asked → { startMs, endMs, allDay, startDate?, endDate? } */
  function timesOf({ start, end, durationMinutes, allDay }, fallbackDurationMs = 3600_000) {
    const zone = tz();
    const s = parseWhen(start, zone);
    const isAllDay = allDay === true || s.allDay;
    if (isAllDay) {
      const startDate = s.date || dateInZone(s.ms, zone);
      let endDate = addDays(startDate, 1);
      if (end) {
        const e = parseWhen(end, zone);
        const last = e.date || dateInZone(e.ms, zone);
        // An all-day end said by people is the last day; stored exclusive.
        endDate = last > startDate ? addDays(last, 1) : addDays(startDate, 1);
      }
      return { allDay: true, startDate, endDate, startMs: startOfDay(startDate, zone), endMs: startOfDay(endDate, zone) };
    }
    let endMs;
    if (end) endMs = parseWhen(end, zone).ms;
    else if (Number(durationMinutes) > 0) endMs = s.ms + Math.min(Number(durationMinutes), 24 * 60 * 14) * 60_000;
    else endMs = s.ms + fallbackDurationMs;
    if (endMs <= s.ms) throw bad('The end must be after the start');
    return { allDay: false, startMs: s.ms, endMs };
  }

  async function overlapsOf(fromMs, toMs, exceptKey) {
    const around = await collect({ fromMs, toMs });
    return around.filter((e) => !e.allDay && `${e.accountId}|${e.id}` !== exceptKey && e._startMs < toMs && e._endMs > fromMs);
  }

  async function afterWrite(accountId) {
    await sync(accountId); // runSync refreshes the digest
  }

  const service = {
    overview: () => ({ accounts: accounts(), settings: store.settings(), google: googleAuth.available() }),
    accounts,

    async addAccount(input = {}, { allowPrivate = false } = {}) {
      const kind = String(input.kind || '');
      let account;
      if (kind === 'ics') {
        const url = String(input.url || '').trim();
        const dup = store.list().find((a) => a.kind === 'ics' && a.url && a.url.replace(/^webcals?/, 'https') === url.replace(/^webcals?/, 'https'));
        if (dup) throw bad('That calendar link is already added', 409);
        const f = await connectFeed({ url, name: input.name }, { allowPrivate, fetchImpl, lookup });
        account = store.add({ kind: 'ics', name: f.name, detail: f.detail, url: f.url, calendars: f.calendars, ...(allowPrivate ? { allowPrivate: true } : {}) });
        store.writeFile(account.id, f.text);
      } else if (kind === 'file') {
        const f = readFile({ filename: input.filename, content: input.content, name: input.name });
        account = store.add({ kind: 'file', name: f.name, detail: f.detail, filename: f.filename, calendars: f.calendars });
        store.writeFile(account.id, f.text);
      } else if (kind === 'caldav') {
        const provider = String(input.provider || 'other');
        if (!PROVIDERS[provider]) throw bad(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
        const c = await caldav.connect({ provider, url: input.url, username: input.username, password: input.password }, { allowPrivate });
        const dup = store.list().find((a) => a.kind === 'caldav' && a.credentials?.serverUrl === c.credentials.serverUrl && a.credentials?.username === c.credentials.username);
        if (dup) {
          account = store.update(dup.id, { credentials: c.credentials, status: 'syncing', error: undefined });
        } else {
          account = store.add({ kind: 'caldav', provider, name: c.name, detail: c.detail, credentials: c.credentials, calendars: c.calendars });
        }
      } else if (kind === 'google') {
        throw bad('Google is connected with POST /api/calendar/google/start');
      } else if (kind === 'device') {
        throw bad("The phone's calendars are added by the phone app (POST /api/calendar/device/sync)");
      } else {
        throw bad('kind must be ics, file or caldav');
      }
      log(`[calendar] Added ${kind} "${account.name}"`);
      await sync(account.id);
      return view(store.get(account.id));
    },

    async updateAccount(id, patch = {}) {
      const account = store.get(id);
      if (!account) throw bad('No such calendar account', 404);
      const changes = {};
      if (typeof patch.name === 'string' && patch.name.trim()) changes.name = patch.name.trim().slice(0, 80);
      if (Array.isArray(patch.calendars)) {
        const want = new Map(patch.calendars.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c.enabled !== false]));
        changes.calendars = (account.calendars || []).map((c) => (want.has(c.id) ? { ...c, enabled: want.get(c.id) } : c));
      }
      let resync = !!changes.calendars && account.kind !== 'device';
      if (account.kind === 'file' && typeof patch.content === 'string') {
        const f = readFile({ filename: patch.filename || account.filename, content: patch.content, name: changes.name || account.name });
        store.writeFile(id, f.text);
        Object.assign(changes, { filename: f.filename, detail: f.detail });
        resync = true;
      }
      store.update(id, changes);
      if (resync) await sync(id);
      else announce();
      return view(store.get(id));
    },

    async syncAccount(id) {
      const account = store.get(id);
      if (!account) throw bad('No such calendar account', 404);
      if (account.status === 'needs_auth') throw bad(account.error || 'Sign in again to sync this account', 409);
      await sync(id);
      return view(store.get(id));
    },

    async removeAccount(id) {
      const account = store.get(id);
      if (!account) return false;
      if (account.kind === 'google') googleAuth.revoke(account.credentials?.refreshToken);
      store.remove(id);
      log(`[calendar] Removed ${account.kind} "${account.name}"`);
      announce();
      refreshDigest();
      return true;
    },

    setSettings(patch = {}) {
      const changes = {};
      if ('defaultCalendar' in patch) {
        const d = patch.defaultCalendar;
        if (d === null) changes.defaultCalendar = null;
        else {
          const a = d && store.get(d.accountId);
          const c = a?.calendars?.find((x) => x.id === d.calendarId);
          if (!c || !c.writable || !['google', 'caldav'].includes(a.kind)) throw bad('Pick a calendar Jarvis can add events to');
          changes.defaultCalendar = { accountId: a.id, calendarId: c.id };
        }
      }
      if ('shareWithVoice' in patch) changes.shareWithVoice = patch.shareWithVoice !== false;
      if ('timeZone' in patch) {
        if (patch.timeZone !== null && !isValidZone(patch.timeZone)) throw bad('Unknown time zone');
        changes.timeZone = patch.timeZone;
      }
      const settings = store.setSettings(changes);
      // Times are cached in the zone's offsets: resync in the new zone.
      if ('timeZone' in changes) for (const a of store.list()) if (a.kind !== 'device') sync(a.id);
      return settings;
    },

    googleStart: () => googleAuth.start(),
    googleStatus: (state) => googleAuth.status(state),
    googleCallback: (q) => googleAuth.callback(q),

    async events({ from, to, q } = {}) {
      const zone = tz();
      const fromMs = from ? parseWhen(from, zone).ms : now();
      const toMs = to ? parseWhen(to, zone).ms : (q ? now() + 60 * DAY : now() + 7 * DAY);
      if (toMs <= fromMs) throw bad('to must be after from');
      if (toMs - fromMs > 400 * DAY) throw bad('Ask for at most about a year at a time');
      return { events: (await collect({ fromMs, toMs, q })).map(strip), timeZone: zone };
    },

    /** POST /events and the add tool. → { event, target, clashes } */
    async createEvent(input = {}) {
      const title = str(input.title, 200);
      if (!title) throw bad('The event needs a title');
      const times = timesOf(input);
      let target;
      if (input.calendar?.accountId) {
        const a = store.get(input.calendar.accountId);
        const c = a?.calendars?.find((x) => x.id === input.calendar.calendarId);
        if (!c || !c.writable || !['google', 'caldav'].includes(a.kind)) throw bad("Jarvis can't add events to that calendar");
        target = { account: a, calendar: c };
      } else target = targetCalendar(typeof input.calendar === 'string' ? input.calendar : undefined);
      if (!target) throw Object.assign(bad('No calendar Jarvis can write to is connected — connect Google Calendar or iCloud in Settings → Calendar'), { code: 'no_writable' });
      const fields = { title, ...times, location: str(input.location, 200), description: str(input.description ?? input.notes, 2000) };
      const clashes = times.allDay ? [] : await overlapsOf(times.startMs, times.endMs);
      let eventId;
      if (target.account.kind === 'google') eventId = (await google.create(target.account, target.calendar.id, fields, tz())).id;
      else eventId = (await caldav.create(target.account, target.calendar.id, fields)).uid;
      await afterWrite(target.account.id);
      const zone = tz();
      const event = (await collect({ fromMs: times.startMs - 1, toMs: times.endMs + 1 })).find((e) => e.accountId === target.account.id && (e.id === eventId || e.id.startsWith(`${eventId}`)))
        || { id: eventId, accountId: target.account.id, calendarId: target.calendar.id, calendarName: target.calendar.name, color: target.calendar.color, title, start: times.allDay ? times.startDate : isoInZone(times.startMs, zone), end: times.allDay ? times.endDate : isoInZone(times.endMs, zone), ...(times.allDay ? { allDay: true } : {}), ...(fields.location ? { location: fields.location } : {}), writable: true, _startMs: times.startMs, _endMs: times.endMs };
      log(`[calendar] Added "${title}" to ${target.calendar.name}`);
      return { event: strip(event), target, clashes: clashes.map(strip) };
    },

    /** PATCH /events and the update tool. */
    async updateEvent(input = {}) {
      const account = store.get(input.accountId);
      if (!account) throw bad('No such calendar account', 404);
      const all = await collect({ fromMs: now() - 60 * DAY, toMs: now() + 365 * DAY });
      const current = all.find((e) => e.accountId === account.id && e.calendarId === input.calendarId && e.id === input.eventId);
      if (!current) throw bad('That event was not found (it may have moved or been deleted)', 404);
      if (!current.writable) throw bad(account.kind === 'caldav' && current.recurring ? 'This is a repeating event: change it in your calendar app' : `"${current.calendarName || account.name}" is read-only for Jarvis`, 409);
      const changes = {};
      if (input.title !== undefined) changes.title = str(input.title, 200) || current.title;
      if (input.location !== undefined) changes.location = typeof input.location === 'string' ? input.location.trim().slice(0, 200) : '';
      if (input.description !== undefined) changes.description = typeof input.description === 'string' ? input.description.slice(0, 2000) : '';
      if (input.start !== undefined || input.end !== undefined || input.durationMinutes !== undefined) {
        const zone = tz();
        const length = current._endMs - current._startMs;
        const start = input.start ?? (current.allDay ? current.start : isoInZone(current._startMs, zone));
        const t = timesOf({ start, end: input.end, durationMinutes: input.durationMinutes, allDay: input.allDay }, length > 0 ? length : 3600_000);
        Object.assign(changes, t);
      }
      if (!Object.keys(changes).length) throw bad('Nothing to change');
      if (account.kind === 'google') await google.update(account, current.calendarId, current.id, changes, tz());
      else if (account.kind === 'caldav') {
        const object = store.cached(account.id)?.objects?.[current.uid || current.id] || store.cached(account.id)?.objects?.[current.id];
        if (!object) throw bad('That event was not found on the server — sync and try again', 404);
        await caldav.update(account, object, changes);
      } else throw bad('This calendar is read-only for Jarvis', 409);
      await afterWrite(account.id);
      const after = (await collect({ fromMs: (changes.startMs ?? current._startMs) - 1, toMs: (changes.endMs ?? current._endMs) + 1 })).find((e) => e.accountId === account.id && e.id === current.id);
      return { event: strip(after || { ...current, ...changes }), before: strip(current) };
    },

    async deleteEvent(input = {}) {
      const account = store.get(input.accountId);
      if (!account) throw bad('No such calendar account', 404);
      const all = await collect({ fromMs: now() - 60 * DAY, toMs: now() + 365 * DAY });
      const current = all.find((e) => e.accountId === account.id && e.calendarId === input.calendarId && e.id === input.eventId);
      if (!current) throw bad('That event was not found (it may already be gone)', 404);
      if (!current.writable) throw bad(account.kind === 'caldav' && current.recurring ? 'This is a repeating event: delete it in your calendar app' : `"${current.calendarName || account.name}" is read-only for Jarvis`, 409);
      if (account.kind === 'google') await google.remove(account, current.calendarId, current.id);
      else {
        const object = store.cached(account.id)?.objects?.[current.id];
        if (!object) throw bad('That event was not found on the server — sync and try again', 404);
        await caldav.remove(account, object);
      }
      await afterWrite(account.id);
      log(`[calendar] Deleted "${current.title}"`);
      return { event: strip(current) };
    },

    /** The phone's own calendars (iOS EventKit / Android CalendarContract), pushed by the app. */
    deviceSync(body = {}) {
      const deviceId = str(body.deviceId, 80);
      if (!deviceId || !/^[\w.-]+$/.test(deviceId)) throw bad('deviceId required');
      const platform = body.platform === 'android' ? 'android' : 'ios';
      const calendars = (Array.isArray(body.calendars) ? body.calendars : []).slice(0, 100).filter((c) => c && typeof c.id === 'string').map((c) => ({
        id: c.id.slice(0, 200), name: str(c.name, 80) || 'Calendar', color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color.toUpperCase() : undefined, writable: false,
      }));
      const zone = tz();
      const fromMs = body.from ? parseWhen(body.from, zone).ms : now() - 7 * DAY;
      const toMs = body.to ? parseWhen(body.to, zone).ms : now() + 60 * DAY;
      const events = [];
      for (const e of (Array.isArray(body.events) ? body.events : []).slice(0, MAX_DEVICE_EVENTS)) {
        if (!e || typeof e.id !== 'string' || typeof e.start !== 'string' || !calendars.some((c) => c.id === e.calendarId)) continue;
        try {
          const s = parseWhen(e.start, zone);
          const allDay = e.allDay === true || s.allDay;
          let endMs = e.end ? parseWhen(e.end, zone).ms : s.ms + (allDay ? DAY : 3600_000);
          if (endMs < s.ms) endMs = s.ms;
          const location = str(e.location, 200);
          const description = str(e.notes, 500);
          const url = str(e.url, 500);
          events.push({
            id: e.id.slice(0, 300),
            calendarId: e.calendarId,
            title: str(e.title, 200) || '(No title)',
            start: allDay ? (s.date || dateInZone(s.ms, zone)) : isoInZone(s.ms, zone),
            end: allDay ? dateInZone(endMs, zone) : isoInZone(endMs, zone),
            ...(allDay ? { allDay: true } : {}),
            ...(location ? { location } : {}),
            ...(description ? { description } : {}),
            ...((url && /zoom|meet\.google|teams|webex|whereby/i.test(url)) || /https?:\/\//.test(location || '') ? { meetingUrl: url || location } : {}),
            writable: false,
            startMs: s.ms,
            endMs,
          });
        } catch { /* skip a malformed event */ }
      }
      const existing = store.list().find((a) => a.kind === 'device' && a.deviceId === deviceId);
      const name = str(body.deviceName, 60) || (platform === 'android' ? 'Android phone' : 'iPhone');
      const known = new Map((existing?.calendars || []).map((c) => [c.id, c]));
      const merged = calendars.map((c) => ({ ...c, enabled: known.get(c.id)?.enabled ?? true }));
      const fields = { name, detail: platform === 'android' ? 'Phone calendars' : 'iPhone calendars', platform, deviceId, calendars: merged, status: 'ready', error: undefined, lastSync: new Date(now()).toISOString() };
      const account = existing ? store.update(existing.id, fields) : store.add({ kind: 'device', ...fields });
      store.setCached(account.id, { syncedAt: fields.lastSync, fromMs, toMs, events });
      announce();
      refreshDigest();
      return view(store.get(account.id));
    },

    /** Opens the agenda card. → { result (to say), data } */
    async show({ day, range, from, to, q, origin, highlightId, title, silent = false } = {}) {
      const zone = tz();
      const hasAccounts = store.list().length > 0;
      let r;
      if (!from && !to && !day && !range && q) r = { fromMs: now() - DAY, toMs: now() + 60 * DAY, title: `Search: ${String(q).slice(0, 40)}` };
      else r = resolveRange({ day, range, from, to }, { tz: zone, now: now() });
      const events = hasAccounts ? await collect({ fromMs: r.fromMs, toMs: r.toMs, q }) : [];
      const data = agendaData(events.map(strip), { title: title || r.title, fromMs: r.fromMs, toMs: r.toMs, tz: zone, highlightId, empty: !hasAccounts });
      if (!silent) broadcast({ type: 'agent_result', agentId: 'jarvis', agentName: 'Jarvis', result: agendaText(data), isDelegated: true, ...(origin ? { origin } : {}) });
      const result = hasAccounts
        ? spokenAgenda(events, { title: r.title, tz: zone, now: now(), refOf, query: q })
        : 'No calendar is connected. Tell the user they can connect Google Calendar, iCloud, Outlook (by link) or their phone\'s calendars in Settings → Calendar, then ask you again.';
      return { result, data };
    },

    /** The voice tools' calls (Gemini Live, OpenAI Realtime, the live avatar). → the text the model gets back. */
    async runTool(name, args = {}, { origin } = {}) {
      try {
        if (name === AGENDA_TOOL.name) {
          return (await service.show({ day: args.day, from: args.from, to: args.to, q: args.query, origin, silent: args.show === false })).result;
        }
        if (name === ADD_EVENT_TOOL.name) {
          try {
            const { event, target, clashes } = await service.createEvent({ title: args.title, start: args.start, end: args.end, durationMinutes: args.durationMinutes, location: args.location, notes: args.notes, calendar: args.calendar });
            const day = event.allDay ? event.start : event.start.slice(0, 10);
            await service.show({ day, origin, highlightId: event.id });
            const when = `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T12:00:00Z`))}, ${timeLabel(event)}`;
            const clash = clashes.length ? ` It overlaps with ${clashes.slice(0, 2).map((c) => `"${c.title}" (${timeLabel(c)})`).join(' and ')} — mention it.` : '';
            return `Added "${event.title}" on ${when} to the "${target.calendar.name}" calendar.${clash}`;
          } catch (e) {
            if (e.code === 'no_writable' && phoneAction) {
              const t = timesOf(args);
              const result = await phoneAction({ action: 'calendar_event', text: args.title, value: t.allDay ? t.startDate : isoInZone(t.startMs, tz()), target: String(Math.round((t.endMs - t.startMs) / 60000)) });
              return `${result} (Added on the phone's calendar: no calendar Jarvis can write to is connected on the computer.)`;
            }
            throw e;
          }
        }
        if (name === UPDATE_EVENT_TOOL.name) {
          const found = await findEvent(args.event);
          if (found.none) return `No event matching "${args.event}" in the next 90 days. Ask the user which event they mean.`;
          if (found.several) return `Several events match: ${found.several.map((e) => `"${e.title}" ${e.start.slice(0, 10)} ${timeLabel(e)} [${refOf(e)}]`).join('; ')}. Ask the user which one.`;
          const e = found.event;
          const { event, before } = await service.updateEvent({ accountId: e.accountId, calendarId: e.calendarId, eventId: e.id, title: args.title, start: args.start, end: args.end, durationMinutes: args.durationMinutes, location: args.location });
          const day = event.allDay ? event.start : event.start.slice(0, 10);
          await service.show({ day, origin, highlightId: event.id });
          return `Changed "${before.title}" (was ${before.start.slice(0, 10)} ${timeLabel(before)}): now "${event.title}" on ${day} ${timeLabel(event)}.`;
        }
        if (name === DELETE_EVENT_TOOL.name) {
          const found = await findEvent(args.event);
          if (found.none) return `No event matching "${args.event}" in the next 90 days.`;
          if (found.several) return `Several events match: ${found.several.map((e) => `"${e.title}" ${e.start.slice(0, 10)} ${timeLabel(e)} [${refOf(e)}]`).join('; ')}. Ask the user which one.`;
          const e = found.event;
          if (args.confirmed !== true) return `Not deleted yet. Ask the user to confirm deleting "${e.title}" on ${e.start.slice(0, 10)} ${timeLabel(e)} [${refOf(e)}], then call again with confirmed=true.`;
          await service.deleteEvent({ accountId: e.accountId, calendarId: e.calendarId, eventId: e.id });
          return `Deleted "${e.title}" (${e.start.slice(0, 10)} ${timeLabel(e)}).`;
        }
        return `Unknown calendar tool ${name}`;
      } catch (e) {
        return `The calendar couldn't do that: ${e.message}`;
      }
    },

    tools: () => CALENDAR_TOOLS,
    isTool: (name) => CALENDAR_TOOLS.some((t) => t.name === name),
    /** The voice models' calendar instruction, with the next 7 days unless the user turned that off. */
    prompt: () => calendarPrompt({ now: now(), tz: tz(), digest: store.settings().shareWithVoice ? digest : null }),
    /** Rebuilds the next-7-days digest now (tests; the service does it after every change). */
    refreshDigest: async () => {
      if (!store.list().length) return (digest = null);
      const zone = tz();
      const fromMs = startOfDay(dateInZone(now(), zone), zone);
      digest = agendaDigest((await collect({ fromMs, toMs: fromMs + 7 * DAY })).map(strip), { tz: zone, now: now() });
      return digest;
    },

    hasAccounts: () => store.list().length > 0,

    /**
     * For the agent CLIs (non-Live mode) when the user mentions their calendar: the next days
     * and how to change events — a local endpoint with a token that lives 15 minutes and only
     * works from this computer (routes.js /api/calendar/agent/<tool>). Null without calendars.
     */
    async agentBrief({ port: p = port, days = 14 } = {}) {
      if (!store.list().length) return null;
      const zone = tz();
      const events = await collect({ fromMs: startOfDay(dateInZone(now(), zone), zone), toMs: now() + days * DAY });
      const token = crypto.randomBytes(18).toString('base64url');
      agentTokens.set(token, now() + 15 * 60_000);
      for (const [t, exp] of agentTokens) if (exp < now()) agentTokens.delete(t);
      const base = `http://127.0.0.1:${p}/api/calendar/agent`;
      const curl = (tool, body) => `curl -s -X POST ${base}/${tool} -H 'Content-Type: application/json' -H 'x-calendar-token: ${token}' -d '${JSON.stringify(body)}'`;
      return [
        spokenAgenda(events, { title: `The user's calendar, next ${days} days`, tz: zone, now: now(), refOf }),
        '',
        `To change the user's calendar, run these commands (times are the user's local time, ${zone}; answer with what they print):`,
        `- add: ${curl('calendar_add_event', { title: 'Lunch with Ana', start: 'YYYY-MM-DDTHH:MM', durationMinutes: 60, location: 'optional' })}`,
        `- move / rename: ${curl('calendar_update_event', { event: 'e3 or title words', start: 'YYYY-MM-DDTHH:MM' })}`,
        `- delete (only if the user clearly asked to delete it): ${curl('calendar_delete_event', { event: 'e3 or title words', confirmed: true })}`,
        `- other dates: ${curl('calendar_agenda', { day: 'next week', show: false })}`,
        'Never mention these commands, refs like [e3] or the token to the user.',
      ].join('\n');
    },
    /** Is `token` a live agent token? */
    agentTokenOk: (token) => !!token && (agentTokens.get(String(token)) || 0) > now(),

    start() {
      if (timer) return;
      setTimeout(syncDue, 5000).unref?.();
      refreshDigest();
      let ticks = 0;
      // Due syncs every minute; the digest every 5 (today moves on, events pass).
      timer = setInterval(() => { syncDue(); if (++ticks % 5 === 0) refreshDigest(); }, 60_000);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    _store: store,
  };
  return service;
}

