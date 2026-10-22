// iCalendar (RFC 5545) in and out: a calendar file / feed / CalDAV object → the events of a
// time window (recurrences expanded, moved and cancelled occurrences applied, every time
// converted with its own TZID), and a new event → the VCALENDAR text a CalDAV server stores.
import crypto from 'node:crypto';
import ICAL from 'ical.js';
import { ianaZone, zonedToUtc, isoInZone } from './tz.js';

// A recurring event without an end is expanded at most this many times per window.
const MAX_ITERATIONS = 20_000;
export const MAX_DESCRIPTION = 500;

const MEETING_RE = /https?:\/\/(?:[\w-]+\.)*(?:meet\.google\.com|zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|whereby\.com|webex\.com|gotomeet(?:ing)?\.(?:com|me)|meet\.jit\.si|chime\.aws|around\.co|app\.gather\.town)\/[^\s<>"')]+/i;

/** The first video-meeting link in an event's texts. */
export function meetingUrlOf(...texts) {
  for (const t of texts) {
    const m = typeof t === 'string' ? MEETING_RE.exec(t) : null;
    if (m) return m[0].replace(/[.,;]+$/, '');
  }
  return undefined;
}

const clean = (s, max) => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  return t ? t.slice(0, max) : undefined;
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dateOf = (t) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
const fieldsOf = (t) => ({ y: t.year, mo: t.month, d: t.day, h: t.hour, mi: t.minute, s: t.second });

/** An ICAL.Time → an instant, read with the TZID its property had (occurrences lose it). */
function instantOf(time, tzid, fallbackTz) {
  const f = fieldsOf(time);
  if (time.zone?.tzid === 'UTC') return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  const iana = ianaZone(tzid);
  if (iana) return zonedToUtc(f, iana);
  const custom = tzid ? ICAL.TimezoneService.get(tzid) : null;
  if (custom) return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - custom.utcOffset(time) * 1000;
  return zonedToUtc(f, fallbackTz); // floating time: the user's zone
}

const tzidOf = (component, name) => component.getFirstProperty(name)?.getParameter('tzid') || null;

/**
 * Parses iCalendar text. Throws a 400 when it isn't one. VTIMEZONEs whose TZID no IANA zone
 * matches are registered so their own rules convert the times.
 */
export function parseCalendar(text) {
  const s = String(text || '');
  if (!/BEGIN:VCALENDAR/i.test(s)) throw Object.assign(new Error("This isn't a calendar file (no BEGIN:VCALENDAR)"), { status: 400 });
  let comp;
  try {
    comp = new ICAL.Component(ICAL.parse(s));
  } catch (e) {
    throw Object.assign(new Error(`The calendar file couldn't be read: ${e.message}`), { status: 400 });
  }
  for (const vtz of comp.getAllSubcomponents('vtimezone')) {
    const id = vtz.getFirstPropertyValue('tzid');
    if (id && !ianaZone(id) && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
  }
  return comp;
}

/** The calendar's own name and color (X-WR-CALNAME, X-APPLE-CALENDAR-COLOR), when it says. */
export function calendarMeta(comp) {
  const name = clean(comp.getFirstPropertyValue('x-wr-calname'), 80);
  const color = String(comp.getFirstPropertyValue('x-apple-calendar-color') || comp.getFirstPropertyValue('color') || '');
  return { name, color: /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7).toUpperCase() : undefined };
}

/**
 * The events of `comp` overlapping [fromMs, toMs): CalendarEvent-like objects without the
 * account/calendar fields. `tz`: floating times and the ISO strings' offsets.
 */
export function expandEvents(comp, { fromMs, toMs, tz, writable = false } = {}) {
  const vevents = comp.getAllSubcomponents('vevent');
  const byUid = new Map();
  for (const ve of vevents) {
    const uid = String(ve.getFirstPropertyValue('uid') || `nouid-${crypto.createHash('sha1').update(ve.toString()).digest('hex').slice(0, 12)}`);
    const entry = byUid.get(uid) || { master: null, exceptions: [] };
    if (ve.hasProperty('recurrence-id')) entry.exceptions.push(ve);
    else if (!entry.master) entry.master = ve;
    byUid.set(uid, entry);
  }

  const out = [];
  const push = (uid, item, startTime, endTime, recurring, occurrenceKey) => {
    const vc = item.component;
    if (String(vc.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return;
    const allDay = startTime.isDate;
    let startMs; let endMs; let start; let end;
    if (allDay) {
      start = dateOf(startTime);
      end = endTime ? dateOf(endTime) : undefined;
      if (!end || end <= start) end = nextDate(start); // all-day ends are exclusive: at least one day
      startMs = zonedToUtc({ ...fieldsOf(startTime), h: 0, mi: 0, s: 0 }, tz);
      endMs = zonedToUtc({ ...parseDateFields(end), h: 0 }, tz);
    } else {
      startMs = instantOf(startTime, tzidOf(vc, 'dtstart'), tz);
      endMs = endTime ? instantOf(endTime, tzidOf(vc, 'dtend') || tzidOf(vc, 'dtstart'), tz) : startMs;
      if (endMs < startMs) endMs = startMs;
      start = isoInZone(startMs, tz);
      end = isoInZone(endMs, tz);
    }
    if (endMs <= fromMs && !(endMs === startMs && startMs >= fromMs)) return;
    if (startMs >= toMs) return;
    const title = clean(item.summary, 200) || '(No title)';
    const location = clean(item.location, 200);
    const description = clean(item.description, MAX_DESCRIPTION);
    const url = clean(String(vc.getFirstPropertyValue('url') || ''), 500);
    const status = String(vc.getFirstPropertyValue('status') || '').toLowerCase();
    out.push({
      id: occurrenceKey ? `${uid}::${occurrenceKey}` : uid,
      uid,
      title,
      start,
      end,
      ...(allDay ? { allDay: true } : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(meetingUrlOf(location, url, description) ? { meetingUrl: meetingUrlOf(location, url, description) } : {}),
      ...(recurring ? { recurring: true } : {}),
      ...(status === 'tentative' ? { status: 'tentative' } : {}),
      writable: writable && !recurring,
      startMs,
      endMs,
    });
  };

  for (const [uid, { master, exceptions }] of byUid) {
    if (!master) {
      // Moved occurrences whose series isn't in this file: plain events.
      for (const ex of exceptions) {
        const ev = new ICAL.Event(ex);
        if (ev.startDate) push(uid, ev, ev.startDate, ev.endDate, true, String(ex.getFirstPropertyValue('recurrence-id')));
      }
      continue;
    }
    let event;
    try {
      event = new ICAL.Event(master);
    } catch {
      continue;
    }
    if (!event.startDate) continue;
    if (!event.isRecurring()) {
      push(uid, event, event.startDate, event.endDate, false, null);
      continue;
    }
    for (const ex of exceptions) {
      try {
        event.relateException(ex);
      } catch { /* an exception for another series */ }
    }
    const masterTzid = tzidOf(master, 'dtstart');
    let it;
    try {
      it = event.iterator();
    } catch {
      continue;
    }
    for (let i = 0, next; i < MAX_ITERATIONS && (next = it.next()); i++) {
      // A cheap bound on the series' own time (moved occurrences are checked in push).
      const approx = next.isDate ? zonedToUtc({ ...fieldsOf(next), h: 0, mi: 0, s: 0 }, tz) : instantOf(next, masterTzid, tz);
      if (approx >= toMs + 36 * 3600_000) break;
      let details;
      try {
        details = event.getOccurrenceDetails(next);
      } catch {
        continue;
      }
      push(uid, details.item, details.startDate, details.endDate, true, next.isDate ? dateOf(next) : isoInZone(approx, 'UTC'));
    }
  }
  out.sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
  return out;
}

function parseDateFields(date) {
  const [y, mo, d] = date.split('-').map(Number);
  return { y, mo, d };
}
function nextDate(date) {
  const { y, mo, d } = parseDateFields(date);
  const t = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// --- Writing -------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateStamp = (date) => date.replace(/-/g, '');

/** Lines longer than 75 octets folded (RFC 5545 §3.1). */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

/** The VEVENT property lines of an event's fields. */
function eventLines({ uid, title, startMs, endMs, allDay, startDate, endDate, location, description, now }) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `LAST-MODIFIED:${utcStamp(now)}`,
    allDay ? `DTSTART;VALUE=DATE:${dateStamp(startDate)}` : `DTSTART:${utcStamp(startMs)}`,
    allDay ? `DTEND;VALUE=DATE:${dateStamp(endDate)}` : `DTEND:${utcStamp(endMs)}`,
    `SUMMARY:${esc(title)}`,
  ];
  if (location) lines.push(`LOCATION:${esc(location)}`);
  if (description) lines.push(`DESCRIPTION:${esc(description)}`);
  lines.push('END:VEVENT');
  return lines;
}

/** A new event as a VCALENDAR object: { uid, text }. */
export function buildEventCalendar(fields, { now = Date.now() } = {}) {
  const uid = fields.uid || `${crypto.randomUUID()}@jarvis-live.xyz`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jarvis Live//Calendar//EN', 'CALSCALE:GREGORIAN', ...eventLines({ ...fields, uid, now }), 'END:VCALENDAR'];
  return { uid, text: `${lines.map(fold).join('\r\n')}\r\n` };
}

/**
 * The stored object with its (single, non-recurring) VEVENT changed: title, times, location,
 * description. Other properties (attendees, alarms…) stay as they were.
 */
export function updateEventCalendar(text, changes, { now = Date.now() } = {}) {
  const comp = parseCalendar(text);
  const vevents = comp.getAllSubcomponents('vevent');
  const ve = vevents.find((v) => !v.hasProperty('recurrence-id'));
  if (!ve) throw Object.assign(new Error('Event not found in its calendar object'), { status: 404 });
  if (ve.hasProperty('rrule') || vevents.length > 1) throw Object.assign(new Error('This is a repeating event: change it in your calendar app'), { status: 409 });
  const set = (name, value) => {
    ve.removeAllProperties(name);
    if (value !== undefined && value !== null && value !== '') ve.addPropertyWithValue(name, value);
  };
  if (changes.title !== undefined) set('summary', changes.title);
  if (changes.location !== undefined) set('location', changes.location);
  if (changes.description !== undefined) set('description', changes.description);
  if (changes.startMs !== undefined || changes.startDate !== undefined) {
    ve.removeAllProperties('dtstart');
    ve.removeAllProperties('dtend');
    ve.removeAllProperties('duration');
    const time = (allDay, ms, date) => (allDay ? ICAL.Time.fromDateString(date) : ICAL.Time.fromJSDate(new Date(ms), true));
    ve.addPropertyWithValue('dtstart', time(changes.allDay, changes.startMs, changes.startDate));
    ve.addPropertyWithValue('dtend', time(changes.allDay, changes.endMs, changes.endDate));
  }
  set('dtstamp', ICAL.Time.fromJSDate(new Date(now), true));
  set('last-modified', ICAL.Time.fromJSDate(new Date(now), true));
  const seq = Number(ve.getFirstPropertyValue('sequence') || 0);
  set('sequence', seq + 1);
  return comp.toString();
}
