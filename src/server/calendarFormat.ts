// Pure helpers for the calendar (Settings → Calendar and the agenda card): time zones, days,
// time ranges, countdowns, sync lines and the add-a-calendar form checks. No React, no store —
// unit-tested with node --test (calendarFormat.test.ts).
import type { CalendarAccount, CalendarRef, CalendarSettings, CaldavProvider, NewCalendarAccount } from './calendar';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── Time zones ───────────────────────────────────────────────────────────────

/** This device's IANA time zone ('UTC' when the runtime can't tell). */
export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** `tz` when the runtime knows it, else null. */
export function validTimeZone(tz?: string | null): string | null {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

/** `tz` if valid, else this device's. */
export const zoneOr = (tz?: string | null): string => validTimeZone(tz) ?? deviceTimeZone();

/** "Europe/Lisbon" → "Lisbon", "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function zoneCity(tz: string): string {
  const last = tz.split('/').pop() || tz;
  return last.replace(/_/g, ' ');
}

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function parts(t: number, tz: string) {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    partsFmt.set(tz, f);
  }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, min: o.minute, s: o.second };
}

/** The zone's offset from UTC at `t`, in ms (Lisbon in summer: +3 600 000). */
export function zoneOffsetMs(t: number, tz: string): number {
  const p = parts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(t / 1000) * 1000;
}

/** "GMT+1" / "GMT-3" / "GMT+5:30" for `tz` at `t`. */
export function zoneOffsetLabel(tz: string, t = Date.now()): string {
  const off = Math.round(zoneOffsetMs(t, tz) / MIN);
  if (!off) return 'GMT';
  const a = Math.abs(off);
  return `GMT${off > 0 ? '+' : '-'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

// ── Days ─────────────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const isDateOnly = (s: unknown): s is string => typeof s === 'string' && DATE_ONLY.test(s);

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day of `t` in `tz`: 'YYYY-MM-DD'. */
export function dayKey(t: number, tz: string): string {
  const p = parts(t, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** 'YYYY-MM-DD' + n days. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const u = new Date(Date.UTC(y, m - 1, d + n));
  return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
}

/** Midnight starting `key` in `tz`, as ms. */
export function startOfDay(key: string, tz: string): number {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - zoneOffsetMs(guess, tz);
  t = guess - zoneOffsetMs(t, tz); // DST: the offset at the real instant
  return t;
}

/** An event bound as ms: ISO with offset as is; a date-only value = that day's midnight in `tz`. NaN if unreadable. */
export function toMs(value: string | undefined, tz: string): number {
  if (!value) return NaN;
  if (isDateOnly(value)) return startOfDay(value, tz);
  return Date.parse(value);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekdayOf = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};

/** 'YYYY-MM-DD' → "Thu 23 Oct" (the year too when it isn't `thisYear`). */
export function shortDate(key: string, thisYear?: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${weekdayOf(key)} ${d} ${MONTHS[m - 1]}${thisYear !== undefined && y !== thisYear ? ` ${y}` : ''}`;
}

/** A day's header: "Today" / "Tomorrow" / "Yesterday" or "Thu 23 Oct", and its date line. */
export function dayHeading(key: string, tz: string, now = Date.now()): { label: string; date: string; relative: 'today' | 'tomorrow' | 'yesterday' | null } {
  const today = dayKey(now, tz);
  const year = Number(today.slice(0, 4));
  const date = shortDate(key, year);
  if (key === today) return { label: 'Today', date, relative: 'today' };
  if (key === addDays(today, 1)) return { label: 'Tomorrow', date, relative: 'tomorrow' };
  if (key === addDays(today, -1)) return { label: 'Yesterday', date, relative: 'yesterday' };
  return { label: date, date, relative: null };
}

// ── Events by day ────────────────────────────────────────────────────────────

export interface EventLike {
  id?: string;
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
}

export const isAllDay = (e: EventLike) => !!e.allDay || isDateOnly(e.start);

export interface DayGroup<T extends EventLike> {
  key: string;
  allDay: T[];
  timed: T[];
}

/**
 * Events → days in `tz`, sorted. All-day events show on each day they cover (the end is
 * exclusive), timed ones on the day they start — or on the range's first day when they began
 * before it and are still on. `from` / `to` (ISO) bound the days shown.
 */
export function groupByDay<T extends EventLike>(events: T[], tz: string, range: { from?: string; to?: string } = {}): DayGroup<T>[] {
  const fromMs = toMs(range.from, tz);
  const toMsV = toMs(range.to, tz);
  const fromKey = Number.isFinite(fromMs) ? dayKey(fromMs, tz) : null;
  const toKey = Number.isFinite(toMsV) ? dayKey(toMsV - 1, tz) : null;
  const inRange = (k: string) => (!fromKey || k >= fromKey) && (!toKey || k <= toKey);
  const days = new Map<string, DayGroup<T>>();
  const at = (k: string) => {
    let g = days.get(k);
    if (!g) { g = { key: k, allDay: [], timed: [] }; days.set(k, g); }
    return g;
  };
  for (const e of events) {
    if (!e || typeof e.start !== 'string') continue;
    if (isAllDay(e)) {
      const first = isDateOnly(e.start) ? e.start : Number.isFinite(Date.parse(e.start)) ? dayKey(Date.parse(e.start), tz) : null;
      if (!first) continue;
      const endKey = isDateOnly(e.end) && e.end > first ? e.end : addDays(first, 1);
      let k = fromKey && first < fromKey ? fromKey : first;
      for (let i = 0; k < endKey && i < 62; i++, k = addDays(k, 1)) if (inRange(k)) at(k).allDay.push(e);
      continue;
    }
    const s = Date.parse(e.start);
    if (!Number.isFinite(s)) continue;
    let k = dayKey(s, tz);
    if (fromKey && k < fromKey) {
      const end = Date.parse(e.end || '');
      if (!(Number.isFinite(end) && end > fromMs)) continue;
      k = fromKey;
    }
    if (inRange(k)) at(k).timed.push(e);
  }
  const byStart = (a: T, b: T) => (toMs(a.start, tz) - toMs(b.start, tz)) || a.title.localeCompare(b.title);
  return [...days.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((g) => ({ key: g.key, allDay: g.allDay.sort(byStart), timed: g.timed.sort(byStart) }));
}

// ── Times ────────────────────────────────────────────────────────────────────

const timeFmt = new Map<string, Intl.DateTimeFormat>();
/** 15:00 / 3:00 PM in `tz` (the device's locale unless `locale` / `hour12` say otherwise). */
export function formatTime(t: number, tz: string, opts: { locale?: string; hour12?: boolean } = {}): string {
  if (!Number.isFinite(t)) return '';
  const id = `${opts.locale ?? ''}|${opts.hour12 ?? ''}|${tz}`;
  let f = timeFmt.get(id);
  if (!f) {
    const base = { minute: '2-digit', timeZone: tz, ...(opts.hour12 !== undefined ? { hour12: opts.hour12 } : {}) } as const;
    f = new Intl.DateTimeFormat(opts.locale, { ...base, hour: 'numeric' });
    // 24-hour clocks keep two digits ("09:30"), so the time column lines up; 12-hour ones read "9:30 AM".
    const cycle = f.resolvedOptions().hourCycle;
    if (cycle === 'h23' || cycle === 'h24') f = new Intl.DateTimeFormat(opts.locale, { ...base, hour: '2-digit' });
    timeFmt.set(id, f);
  }
  return f.format(new Date(t)).replace(/[\u202f\u00a0]/g, ' ');
}

/** "15:00 – 16:30", "22:00 – Fri 01:00", "All day", "All day · until Sun 26 Oct". */
export function formatTimeRange(e: EventLike, tz: string, opts: { locale?: string; hour12?: boolean } = {}): string {
  if (isAllDay(e)) {
    const first = isDateOnly(e.start) ? e.start : '';
    if (first && isDateOnly(e.end) && e.end > addDays(first, 1)) return `All day · until ${shortDate(addDays(e.end, -1))}`;
    return 'All day';
  }
  const s = Date.parse(e.start);
  const end = Date.parse(e.end || '');
  const a = formatTime(s, tz, opts);
  if (!Number.isFinite(end) || end <= s) return a;
  const sameDay = dayKey(s, tz) === dayKey(end - 1, tz);
  return `${a} – ${sameDay ? '' : `${weekdayOf(dayKey(end, tz))} `}${formatTime(end, tz, opts)}`;
}

/** "45 min", "1 h", "1 h 30 min", "2 days". */
export function durationLabel(startMs: number, endMs: number): string {
  const ms = endMs - startMs;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms >= DAY && ms % DAY === 0) return `${ms / DAY} day${ms / DAY > 1 ? 's' : ''}`;
  const total = Math.round(ms / MIN);
  const h = Math.floor(total / 60), m = total % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

/** Time until `target`: "in 25 min", "in 1 h 5 min", "in 6 h", "in 3 days" ("now" within the minute). */
export function countdown(target: number, now = Date.now()): string {
  const ms = target - now;
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'now';
  const m = Math.round(ms / MIN);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  if (h < 3) return `in ${h} h${rest ? ` ${rest} min` : ''}`;
  if (ms < DAY) return `in ${Math.round(ms / HOUR)} h`;
  const d = Math.round(ms / DAY);
  return d === 1 ? 'in 1 day' : `in ${d} days`;
}

export type EventPhase = 'past' | 'now' | 'upcoming';

/** Where an event stands at `now` (no end: a 1-minute event). */
export function eventPhase(e: EventLike, tz: string, now = Date.now()): EventPhase {
  const s = toMs(e.start, tz);
  let end = toMs(e.end, tz);
  if (!Number.isFinite(end) || end <= s) end = isAllDay(e) ? startOfDay(addDays(isDateOnly(e.start) ? e.start : dayKey(s, tz), 1), tz) : s + MIN;
  if (now < s) return 'upcoming';
  return now < end ? 'now' : 'past';
}

/** 0…1 through an ongoing timed event. */
export function progressOf(e: EventLike, now = Date.now()): number {
  const s = Date.parse(e.start), end = Date.parse(e.end || '');
  if (!Number.isFinite(s) || !Number.isFinite(end) || end <= s) return 0;
  return Math.max(0, Math.min(1, (now - s) / (end - s)));
}

/** The next timed event that hasn't ended (an ongoing one first), with "in 25 min" / "now · ends in 20 min". */
export function nextUp<T extends EventLike>(events: T[], now = Date.now()): { event: T; phase: 'now' | 'upcoming'; label: string } | null {
  let best: { event: T; s: number; end: number } | null = null;
  for (const e of events) {
    if (!e || isAllDay(e)) continue;
    const s = Date.parse(e.start);
    if (!Number.isFinite(s)) continue;
    const parsedEnd = Date.parse(e.end || '');
    const end = Number.isFinite(parsedEnd) && parsedEnd > s ? parsedEnd : s + MIN;
    if (end <= now) continue;
    if (!best || s < best.s) best = { event: e, s, end };
  }
  if (!best) return null;
  if (best.s <= now) {
    const left = countdown(best.end, now);
    return { event: best.event, phase: 'now', label: left === 'now' ? 'now · ending' : `now · ends ${left}` };
  }
  return { event: best.event, phase: 'upcoming', label: countdown(best.s, now) };
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", else "Sep 8". */
export function timeAgo(iso: string | undefined, now = Date.now()): string {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return `${MONTHS[new Date(t).getMonth()]} ${new Date(t).getDate()}`;
}

/** "Synced 2 min ago · 124 events". */
export function syncLine(a: Pick<CalendarAccount, 'lastSync' | 'eventCount'>, now = Date.now()): string {
  const ago = timeAgo(a.lastSync, now);
  const n = typeof a.eventCount === 'number' && Number.isFinite(a.eventCount) ? a.eventCount : null;
  return [ago ? `Synced ${ago}` : 'Synced', n === null ? '' : `${n.toLocaleString('en-US')} event${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}

/** "3 of 5 calendars" / "1 calendar". */
export function calendarsLine(a: Pick<CalendarAccount, 'calendars'>): string {
  const all = a.calendars?.length ?? 0;
  const on = a.calendars?.filter((c) => c.enabled).length ?? 0;
  if (!all) return '';
  return on === all ? `${all} calendar${all === 1 ? '' : 's'}` : `${on} of ${all} calendars`;
}

/** '#RRGGBB' (a '#RGB' is expanded), else `fallback`. Cards append alpha to it, so anything else is refused. */
export function safeColor(c: unknown, fallback: string): string {
  if (typeof c !== 'string') return fallback;
  const v = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  const s = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  return s ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase() : fallback;
}

export const sameRef = (a: CalendarRef | null | undefined, b: CalendarRef | null | undefined) =>
  !!a && !!b && a.accountId === b.accountId && a.calendarId === b.calendarId;

export interface WritableTarget { ref: CalendarRef; name: string; account: string; color?: string }

/** Calendars Jarvis can add events to (writable and on, in an account that hasn't lost access), for the "Add events to" picker. */
export function writableTargets(accounts: CalendarAccount[]): WritableTarget[] {
  const out: WritableTarget[] = [];
  for (const a of accounts) {
    if (a.status === 'needs_auth') continue;
    for (const c of a.calendars || []) {
      if (c.writable && c.enabled) out.push({ ref: { accountId: a.id, calendarId: c.id }, name: c.name, account: a.name, color: c.color });
    }
  }
  return out;
}

/** The calendar new events go to: the setting when it still exists, else the first writable one (primary first). */
export function effectiveDefault(accounts: CalendarAccount[], settings: Pick<CalendarSettings, 'defaultCalendar'>): WritableTarget | null {
  const targets = writableTargets(accounts);
  const set = targets.find((t) => sameRef(t.ref, settings.defaultCalendar));
  if (set) return set;
  const primary = targets.find((t) => accounts.find((a) => a.id === t.ref.accountId)?.calendars.find((c) => c.id === t.ref.calendarId)?.primary);
  return primary ?? targets[0] ?? null;
}

// ── Adding a calendar ────────────────────────────────────────────────────────

export const MAX_ICS_BYTES = 5 * 1024 * 1024;

/** A link to show without its secret part: "calendar.google.com/…/basic.ics". */
export function maskLink(url: string): string {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return url.length > 32 ? `${url.slice(0, 28)}…` : url; }
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  // A long or dot-less last segment is usually the token itself.
  const tail = last && last.length <= 24 && /\./.test(last) ? last : '';
  if (!segs.length) return u.host;
  return `${u.host}/…${tail ? `/${tail}` : ''}`;
}

/** A pasted ICS link → the URL to send, or why it isn't one. */
export function normalizeIcsLink(input: string): { url: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Paste the calendar’s link.' };
  if (/\s/.test(raw)) return { error: 'A link has no spaces.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { error: 'Paste the whole link, starting with https:// or webcal://.' };
  let u: URL;
  try { u = new URL(raw); } catch { return { error: 'That doesn’t look like a link.' }; }
  const scheme = u.protocol.toLowerCase();
  if (scheme === 'http:') return { error: 'Use the https:// version of the link.' };
  if (!['https:', 'webcal:', 'webcals:'].includes(scheme)) return { error: 'Use an https:// or webcal:// link.' };
  if (!u.hostname || !/\./.test(u.hostname)) return { error: 'That doesn’t look like a link.' };
  return { url: raw };
}

export interface CaldavProviderInfo {
  label: string;
  /** The server URL must be typed. */
  needsUrl: boolean;
  usernameLabel: string;
  usernamePlaceholder: string;
  urlPlaceholder?: string;
  passwordLabel: string;
  /** Where the app password comes from. */
  passwordHint: string;
  helpUrl?: string;
}

export const CALDAV_PROVIDERS: Record<CaldavProvider, CaldavProviderInfo> = {
  icloud: {
    label: 'iCloud', needsUrl: false, usernameLabel: 'Apple ID', usernamePlaceholder: 'you@icloud.com',
    passwordLabel: 'App-specific password', passwordHint: 'appleid.apple.com → Sign-In and Security → App-Specific Passwords. Your Apple ID password won’t work.',
    helpUrl: 'https://appleid.apple.com/account/manage',
  },
  fastmail: {
    label: 'Fastmail', needsUrl: false, usernameLabel: 'Email', usernamePlaceholder: 'you@fastmail.com',
    passwordLabel: 'App password', passwordHint: 'Fastmail → Settings → Privacy & Security → App passwords → New (access: Calendars).',
    helpUrl: 'https://app.fastmail.com/settings/security/apps',
  },
  nextcloud: {
    label: 'Nextcloud', needsUrl: true, usernameLabel: 'Username', usernamePlaceholder: 'your Nextcloud username',
    urlPlaceholder: 'https://cloud.example.com/remote.php/dav',
    passwordLabel: 'App password', passwordHint: 'Nextcloud → Personal settings → Security → Devices & sessions → Create new app password.',
  },
  yahoo: {
    label: 'Yahoo', needsUrl: false, usernameLabel: 'Yahoo email', usernamePlaceholder: 'you@yahoo.com',
    passwordLabel: 'App password', passwordHint: 'Yahoo → Account info → Account security → Generate app password.',
    helpUrl: 'https://login.yahoo.com/myaccount/security/',
  },
  other: {
    label: 'Other', needsUrl: true, usernameLabel: 'Username', usernamePlaceholder: 'username or email',
    urlPlaceholder: 'https://caldav.example.com/',
    passwordLabel: 'Password', passwordHint: 'If your provider offers app passwords, use one.',
  },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The CalDAV form → the POST body, or the first thing to fix. */
export function caldavBody(f: { provider: CaldavProvider; username: string; password: string; url?: string }): { body: NewCalendarAccount } | { error: string } {
  const info = CALDAV_PROVIDERS[f.provider];
  if (!info) return { error: 'Choose your provider.' };
  const username = f.username.trim();
  if (!username) return { error: `Type your ${info.usernameLabel.toLowerCase()}.` };
  if ((f.provider === 'icloud' || f.provider === 'yahoo' || f.provider === 'fastmail') && !EMAIL.test(username)) return { error: `Your ${info.usernameLabel} is an email address.` };
  // App passwords are often shown with spaces or dashes ("abcd-efgh-…") — sent exactly as typed.
  if (!f.password) return { error: `Type the ${info.passwordLabel.toLowerCase()}.` };
  let url: string | undefined;
  if (info.needsUrl) {
    const raw = (f.url || '').trim();
    if (!raw) return { error: 'Type your CalDAV server’s address.' };
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Use an https:// address.' };
      url = u.toString();
    } catch { return { error: 'That doesn’t look like a server address.' }; }
  }
  return { body: { kind: 'caldav', provider: f.provider, username, password: f.password, ...(url ? { url } : {}) } };
}

/** A picked .ics file → why it can't be imported, or null. */
export function icsFileProblem(file: { name: string; size: number }): string | null {
  if (file.size > MAX_ICS_BYTES) return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — 5 MB at most.`;
  if (!file.size) return 'That file is empty.';
  if (!/\.(ics|ical|ifb|icalendar)$/i.test(file.name)) return 'Choose an .ics calendar file.';
  return null;
}

/** The file's text is a calendar. */
export const looksLikeIcs = (text: string) => /BEGIN:VCALENDAR/i.test(text.slice(0, 4096));

// ── Agenda card ──────────────────────────────────────────────────────────────

/** A meeting link safe to open (https only), with its button label: "Join Meet" / "Join Zoom" / "Join Teams" / "Join". */
export function meetingLink(url: unknown): { href: string; label: string } | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  const label = h === 'meet.google.com' ? 'Join Meet'
    : /(^|\.)zoom\.us$/.test(h) ? 'Join Zoom'
      : /(^|\.)teams\.(microsoft|live)\.com$/.test(h) ? 'Join Teams'
        : /(^|\.)webex\.com$/.test(h) ? 'Join Webex'
          : 'Join';
  return { href: u.toString(), label };
}

/** The range under the card's title: "Wed 22 Oct" or "Mon 20 – Sun 26 Oct" ('' when unreadable). */
export function rangeLabel(from: string | undefined, to: string | undefined, tz: string, now = Date.now()): string {
  const f = toMs(from, tz), t = toMs(to, tz);
  if (!Number.isFinite(f)) return '';
  const year = Number(dayKey(now, tz).slice(0, 4));
  const a = dayKey(f, tz);
  const b = Number.isFinite(t) && t > f ? dayKey(t - 1, tz) : a;
  if (a === b) return shortDate(a, year);
  const [, am] = a.split('-');
  const [, bm] = b.split('-');
  const left = shortDate(a, year);
  return `${am === bm && a.slice(0, 4) === b.slice(0, 4) ? left.replace(/ [A-Z][a-z]{2}( \d{4})?$/, '') : left} – ${shortDate(b, year)}`;
}
