// A calendar subscription link (an .ics feed: Google's "secret address in iCal format",
// Outlook's published calendar, iCloud public calendars, schools, teams, sports fixtures…) and an
// imported .ics file. Read-only: Jarvis reads them, the owner of the feed changes them.
import { fetchLimited, checkHost } from '../../business/scanWebsite.js';
import { calendarMeta, expandEvents, parseCalendar } from '../ics.js';
import { maskUrl } from '../store.js';

export const MAX_FEED_BYTES = 15 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const LIMITS = { timeoutMs: 25_000, maxBytes: MAX_FEED_BYTES + 1, maxRedirects: 5 };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
/** A home-network address refused for a phone: say where it can be added. */
const privateHint = (msg) => (/not a public address/.test(msg) ? `${msg.replace(/^Refused: /, '')} — a server on your home network can only be added from Settings on the computer itself` : msg);

/** 'webcal://…' → 'https://…'; throws a 400 on anything that isn't an http(s) link. */
export function normalizeFeedUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw bad('Paste the calendar link');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad("That isn't a link");
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('Use an https:// or webcal:// link');
  u.hash = '';
  return u.toString();
}

/** The feed's text (throws a 400/502 that says what went wrong). */
export async function downloadFeed(url, { allowPrivate = false, fetchImpl, lookup } = {}) {
  let res;
  try {
    res = await fetchLimited(url, { allowPrivate, fetchImpl, lookup, limits: LIMITS, headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' } });
  } catch (e) {
    throw bad(/not a public address/.test(e.message) ? e.message : `The calendar link couldn't be opened: ${e.message}`, 502);
  }
  if (res.status === 401 || res.status === 403) throw bad('The calendar link refused access — check it is the private/secret address and still valid', 502);
  if (res.status === 404) throw bad('The calendar link was not found (404) — it may have been reset', 502);
  if (res.status >= 400) throw bad(`The calendar link answered HTTP ${res.status}`, 502);
  if (res.body.length > MAX_FEED_BYTES) throw bad('That calendar is too large (over 15 MB)');
  const text = res.body.toString('utf8');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw bad(/<html/i.test(text) ? 'That link opens a web page, not a calendar: copy the iCal / .ics address' : "That link isn't an iCalendar feed", 400);
  return text;
}

/** First connection of a link: checks it and names it. → { name, detail, url, calendars, text } */
export async function connectFeed({ url: input, name }, { allowPrivate = false, fetchImpl, lookup } = {}) {
  const url = normalizeFeedUrl(input);
  await checkHost(new URL(url).hostname, { allowPrivate, lookup }).catch((e) => { throw bad(privateHint(e.message)); });
  const text = await downloadFeed(url, { allowPrivate, fetchImpl, lookup });
  const meta = calendarMeta(parseCalendar(text));
  const title = String(name || '').trim().slice(0, 80) || meta.name || new URL(url).hostname.replace(/^www\./, '');
  return {
    name: title,
    detail: `Subscribed link · ${maskUrl(url)}`,
    url,
    calendars: [{ id: 'feed', name: meta.name || title, color: meta.color, enabled: true, writable: false }],
    text,
  };
}

/** An imported file. → { name, detail, calendars, text } */
export function readFile({ filename, content, name }) {
  const text = String(content || '');
  if (!text.trim()) throw bad('The file is empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw bad('That file is too large (over 5 MB)');
  const meta = calendarMeta(parseCalendar(text));
  const file = String(filename || 'calendar.ics').replace(/[\\/]/g, '_').slice(0, 120);
  const title = String(name || '').trim().slice(0, 80) || meta.name || file.replace(/\.(ics|ical|ifb|icalendar)$/i, '');
  return {
    name: title,
    detail: `Imported file · ${file}`,
    filename: file,
    calendars: [{ id: 'file', name: meta.name || title, color: meta.color, enabled: true, writable: false }],
    text,
  };
}

/** The events of a feed / file text in a window, tagged with the one calendar. */
export function eventsOfText(text, calendarId, window) {
  return expandEvents(parseCalendar(text), window).map((e) => ({ ...e, calendarId, writable: false }));
}
