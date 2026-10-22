// Google Calendar (REST v3) with the account's OAuth tokens (googleAuth.js refreshes them).
// Recurring series come expanded (singleEvents=true), so a single occurrence can be moved or
// deleted like any event.
import { meetingUrlOf, MAX_DESCRIPTION } from '../ics.js';
import { isoInZone, zonedToUtc, parseDate } from '../tz.js';

const API = 'https://www.googleapis.com/calendar/v3';
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MAX_PAGES = 10;

const clip = (s, n) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : undefined);
const dayMs = (date, tz) => zonedToUtc({ ...parseDate(date), h: 0 }, tz);

/** A Google event → CalendarEvent fields (without accountId). */
export function fromGoogle(item, calendarId, { tz, writable }) {
  const allDay = !!item.start?.date;
  const startMs = allDay ? dayMs(item.start.date, tz) : Date.parse(item.start?.dateTime);
  const endMs = allDay ? dayMs(item.end?.date || item.start.date, tz) : Date.parse(item.end?.dateTime || item.start?.dateTime);
  const video = item.hangoutLink || item.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  const description = clip(item.description?.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '), MAX_DESCRIPTION);
  const location = clip(item.location, 200);
  return {
    id: item.id,
    uid: item.iCalUID || item.id,
    calendarId,
    title: clip(item.summary, 200) || '(No title)',
    start: allDay ? item.start.date : isoInZone(startMs, tz),
    end: allDay ? item.end?.date : isoInZone(endMs, tz),
    ...(allDay ? { allDay: true } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...((video || meetingUrlOf(location, description)) ? { meetingUrl: video || meetingUrlOf(location, description) } : {}),
    ...(item.recurringEventId ? { recurring: true } : {}),
    ...(item.status === 'tentative' ? { status: 'tentative' } : {}),
    writable: writable && item.eventType !== 'birthday' && !item.locked,
    startMs,
    endMs,
  };
}

/** Event fields → Google's body. */
function toGoogle({ title, startMs, endMs, allDay, startDate, endDate, location, description }, tz) {
  const body = {};
  if (title !== undefined) body.summary = title;
  if (location !== undefined) body.location = location || '';
  if (description !== undefined) body.description = description || '';
  if (startMs !== undefined || startDate !== undefined) {
    body.start = allDay ? { date: startDate } : { dateTime: new Date(startMs).toISOString(), timeZone: tz };
    body.end = allDay ? { date: endDate } : { dateTime: new Date(endMs).toISOString(), timeZone: tz };
  }
  return body;
}

/**
 * `token(account)` → a valid access token (refreshing as needed); `retryToken(account)` → a new
 * one after a 401.
 */
export function createGoogle({ token, retryToken, fetchImpl = fetch } = {}) {
  async function call(account, method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = attempt === 0 ? await token(account) : await retryToken(account);
      const r = await fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${access}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 401 && attempt === 0) continue;
      if (r.status === 204) return null;
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data;
      const reason = data.error?.errors?.[0]?.reason || data.error?.status || '';
      if (r.status === 403 && /insufficient|scope/i.test(`${reason} ${data.error?.message}`)) throw bad('Google needs your permission again — remove the account and connect it again', 403);
      if (r.status === 404 || r.status === 410) throw bad('That event or calendar no longer exists', 404);
      throw bad(`Google Calendar: ${data.error?.message || `HTTP ${r.status}`}`, r.status >= 500 ? 502 : r.status);
    }
    throw bad('Google access was removed — sign in again', 401);
  }

  async function calendars(account) {
    const known = new Map((account.calendars || []).map((x) => [x.id, x]));
    const data = await call(account, 'GET', '/users/me/calendarList?maxResults=250&minAccessRole=reader');
    return (data.items || [])
      .filter((c) => !c.deleted && !c.hidden)
      .map((c) => ({
        id: c.id,
        name: clip(c.summaryOverride || c.summary, 80) || c.id,
        color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor || '') ? c.backgroundColor.toUpperCase() : undefined,
        // New calendars: on when the user owns them or it's the primary; subscribed ones (holidays,
        // birthdays, colleagues') start off so the agenda isn't flooded — one tap turns them on.
        enabled: known.get(c.id)?.enabled ?? (c.primary || c.accessRole === 'owner'),
        writable: c.accessRole === 'owner' || c.accessRole === 'writer',
        ...(c.primary ? { primary: true } : {}),
      }))
      .sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.name.localeCompare(b.name));
  }

  return {
    calendars,

    async fetch(account, { fromMs, toMs, tz }) {
      const cals = await calendars(account);
      const events = [];
      for (const cal of cals) {
        if (!cal.enabled) continue;
        let pageToken;
        for (let page = 0; page < MAX_PAGES; page++) {
          const q = new URLSearchParams({
            timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
            singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', showDeleted: 'false',
            ...(pageToken ? { pageToken } : {}),
          });
          const data = await call(account, 'GET', `/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
          for (const item of data.items || []) {
            if (item.status === 'cancelled' || !item.start) continue;
            // Declined invitations aren't on the user's day.
            if (item.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
            events.push(fromGoogle(item, cal.id, { tz, writable: cal.writable }));
          }
          pageToken = data.nextPageToken;
          if (!pageToken) break;
        }
      }
      return { calendars: cals, events };
    },

    async create(account, calendarId, fields, tz) {
      const item = await call(account, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, toGoogle(fields, tz));
      return fromGoogle(item, calendarId, { tz, writable: true });
    },

    async update(account, calendarId, eventId, changes, tz) {
      const item = await call(account, 'PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, toGoogle(changes, tz));
      return fromGoogle(item, calendarId, { tz, writable: true });
    },

    async remove(account, calendarId, eventId) {
      await call(account, 'DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    },
  };
}
