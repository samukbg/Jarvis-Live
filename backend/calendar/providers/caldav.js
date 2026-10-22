// CalDAV (RFC 4791): iCloud, Fastmail, Nextcloud, Yahoo and any standard server. Signed in with
// the user name and an app-specific password; Jarvis reads every event calendar and can add,
// change and delete events in them (one-off events; repeating series stay in the user's app).
import { DAVClient } from 'tsdav';
import { checkHost } from '../../business/scanWebsite.js';
import { buildEventCalendar, expandEvents, parseCalendar, updateEventCalendar } from '../ics.js';

export const PROVIDERS = {
  icloud: { label: 'iCloud', url: 'https://caldav.icloud.com', passwordHelp: 'an app-specific password from appleid.apple.com' },
  fastmail: { label: 'Fastmail', url: 'https://caldav.fastmail.com', passwordHelp: 'an app password (Fastmail → Settings → Privacy & Security)' },
  yahoo: { label: 'Yahoo', url: 'https://caldav.calendar.yahoo.com', passwordHelp: 'an app password (Yahoo → Account Security)' },
  nextcloud: { label: 'Nextcloud', url: null, passwordHelp: 'an app password (Nextcloud → Settings → Security)' },
  other: { label: 'CalDAV', url: null, passwordHelp: 'your password or an app password' },
};

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
/** A home-network address refused for a phone: say where it can be added. */
const privateHint = (msg) => (/not a public address/.test(msg) ? `${msg.replace(/^Refused: /, '')} — a server on your home network can only be added from Settings on the computer itself` : msg);
const COLOR_RE = /^#?([0-9a-f]{6})/i;

/** The server URL to discover from: the provider's, or the user's (Nextcloud: its DAV root). */
export function serverUrlOf(provider, url) {
  const p = PROVIDERS[provider];
  if (!p) throw bad(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
  if (p.url) return p.url;
  let s = String(url || '').trim();
  if (!s) throw bad(`Enter your ${p.label} server address`);
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad("That server address isn't a link");
  }
  if (provider === 'nextcloud' && !/remote\.php\/dav/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/remote.php/dav`;
  return u.toString().replace(/\/+$/, '');
}

const nameOf = (c) => (typeof c.displayName === 'string' && c.displayName.trim() ? c.displayName.trim().slice(0, 80) : decodeURIComponent(c.url.split('/').filter(Boolean).pop() || 'Calendar'));
const colorOf = (c) => {
  const m = COLOR_RE.exec(String(c.calendarColor || ''));
  return m ? `#${m[1].toUpperCase()}` : undefined;
};
const isEventCalendar = (c) => !Array.isArray(c.components) || !c.components.length || c.components.includes('VEVENT');

/** A friendly sentence for a sign-in failure. */
function signInError(e, provider) {
  const msg = String(e?.message || e);
  const label = PROVIDERS[provider]?.label || 'CalDAV';
  if (/401|unauthori[sz]ed|invalid credentials|forbidden|403/i.test(msg)) {
    return bad(provider === 'icloud'
      ? 'Apple ID or app-specific password is wrong (use an app-specific password, not your Apple ID password)'
      : `${label} refused the user name or password — use ${PROVIDERS[provider]?.passwordHelp || 'an app password'}`);
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return bad(`Can't reach the ${label} server — check the address`, 502);
  if (/cannot find homeUrl|no calendar|principal/i.test(msg)) return bad(`That ${label} account has no calendars Jarvis can read`, 400);
  return bad(`${label} sign-in failed: ${msg.slice(0, 160)}`, 502);
}

export function createCaldav({ fetchImpl, lookup } = {}) {
  /** A logged-in DAV client for an account's credentials. */
  async function client({ serverUrl, username, password }, provider) {
    const c = new DAVClient({
      serverUrl,
      credentials: { username, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      ...(fetchImpl ? { fetchOverride: fetchImpl } : {}),
    });
    try {
      await c.login();
    } catch (e) {
      throw signInError(e, provider);
    }
    return c;
  }

  async function listCalendars(c, provider) {
    let cals;
    try {
      cals = await c.fetchCalendars();
    } catch (e) {
      throw signInError(e, provider);
    }
    return cals.filter(isEventCalendar);
  }

  return {
    /** Signs in and lists the calendars. → { name, detail, credentials, calendars } */
    async connect({ provider, url, username, password }, { allowPrivate = false } = {}) {
      const user = String(username || '').trim();
      const pass = String(password || '');
      if (!user) throw bad(provider === 'icloud' ? 'Enter your Apple ID' : 'Enter your user name');
      if (!pass) throw bad(provider === 'icloud' ? 'Enter an app-specific password' : 'Enter the password');
      const serverUrl = serverUrlOf(provider, url);
      await checkHost(new URL(serverUrl).hostname, { allowPrivate, lookup }).catch((e) => { throw bad(privateHint(e.message)); });
      const credentials = { serverUrl, username: user, password: pass };
      const c = await client(credentials, provider);
      const cals = await listCalendars(c, provider);
      if (!cals.length) throw bad(`That ${PROVIDERS[provider].label} account has no calendars`);
      return {
        name: provider === 'icloud' ? `iCloud · ${user}` : user,
        detail: provider === 'other' || provider === 'nextcloud' ? new URL(serverUrl).hostname : `${PROVIDERS[provider].label} Calendar`,
        credentials,
        calendars: cals.map((cal) => ({ id: cal.url, name: nameOf(cal), color: colorOf(cal), enabled: true, writable: true })),
      };
    },

    /**
     * Events of the enabled calendars in a window. → { calendars (refreshed list, keeping the
     * user's toggles), events, objects: { [uid]: { url, etag, calendarId } } }
     */
    async fetch(account, { fromMs, toMs, tz }) {
      const c = await client(account.credentials, account.provider);
      const cals = await listCalendars(c, account.provider);
      const known = new Map((account.calendars || []).map((x) => [x.id, x]));
      const calendars = cals.map((cal) => ({
        id: cal.url, name: nameOf(cal), color: colorOf(cal), enabled: known.get(cal.url)?.enabled ?? true, writable: true,
      }));
      const events = [];
      const objects = {};
      for (const cal of cals) {
        if (calendars.find((x) => x.id === cal.url)?.enabled === false) continue;
        const objs = await c.fetchCalendarObjects({
          calendar: cal,
          timeRange: { start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString() },
        });
        for (const o of objs) {
          if (!o?.data) continue;
          let list;
          try {
            list = expandEvents(parseCalendar(o.data), { fromMs, toMs, tz, writable: true });
          } catch {
            continue; // one broken object doesn't hide the others
          }
          for (const ev of list) {
            events.push({ ...ev, calendarId: cal.url });
            objects[ev.uid] = { url: o.url, etag: o.etag, calendarId: cal.url };
          }
        }
      }
      return { calendars, events, objects };
    },

    async create(account, calendarId, fields) {
      const c = await client(account.credentials, account.provider);
      const cal = (await listCalendars(c, account.provider)).find((x) => x.url === calendarId);
      if (!cal) throw bad('That calendar no longer exists', 404);
      const { uid, text } = buildEventCalendar(fields);
      const res = await c.createCalendarObject({ calendar: cal, filename: `${encodeURIComponent(uid.replace(/@.*/, ''))}.ics`, iCalString: text });
      if (res && res.ok === false) throw bad(`The calendar refused the new event (HTTP ${res.status})`, 502);
      return { uid };
    },

    async update(account, object, changes) {
      const c = await client(account.credentials, account.provider);
      const [current] = await c.fetchCalendarObjects({ calendar: { url: object.calendarId }, objectUrls: [object.url] }).catch(() => []);
      const data = current?.data;
      if (!data) throw bad('That event no longer exists', 404);
      const text = updateEventCalendar(data, changes);
      const res = await c.updateCalendarObject({ calendarObject: { url: object.url, etag: current.etag || object.etag, data: text } });
      if (res && res.ok === false) throw bad(res.status === 412 ? 'The event changed in the meantime — try again' : `The calendar refused the change (HTTP ${res.status})`, 502);
    },

    async remove(account, object) {
      const c = await client(account.credentials, account.provider);
      const res = await c.deleteCalendarObject({ calendarObject: { url: object.url, etag: object.etag } });
      if (res && res.ok === false && res.status !== 404) throw bad(res.status === 412 ? 'The event changed in the meantime — try again' : `The calendar refused to delete it (HTTP ${res.status})`, 502);
    },
  };
}
