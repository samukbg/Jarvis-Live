// Time zones for the calendar, with nothing but Intl: wall-clock times in an IANA zone ↔ UTC,
// ISO strings with the zone's offset, day boundaries, and the TZIDs calendar files really use
// (IANA names, Outlook's Windows names, Mozilla-style prefixed paths).

const DTF = new Map();
function partsFormatter(tz) {
  let f = DTF.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    DTF.set(tz, f);
  }
  return f;
}

/** Is `tz` an IANA zone this runtime knows? */
export function isValidZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    partsFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** This computer's zone (UTC when unknown). */
export const systemZone = () => {
  const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidZone(z) ? z : 'UTC';
};

/** The wall-clock fields of `ms` in `tz`: { y, mo, d, h, mi, s } (month 1–12). */
export function wallFields(ms, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** `tz`'s offset from UTC at instant `ms`, in minutes (Lisbon in summer: 60). */
export function offsetMinutes(ms, tz) {
  const w = wallFields(ms, tz);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * The instant of a wall-clock time in `tz`. In a DST gap (02:30 on a spring-forward night) it
 * lands after the gap; in an overlap, on the first of the two.
 */
export function zonedToUtc({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = offsetMinutes(guess, tz);
  let t = guess - off1 * 60000;
  const off2 = offsetMinutes(t, tz);
  if (off2 !== off1) {
    const t2 = guess - off2 * 60000;
    // Pick the reading that maps back to the asked wall time when one does.
    t = offsetMinutes(t2, tz) === off2 ? t2 : t;
  }
  return t;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** '2026-10-22' of instant `ms` in `tz`. */
export function dateInZone(ms, tz) {
  const w = wallFields(ms, tz);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}`;
}

/** '2026-10-22T15:00:00+01:00': instant `ms` as `tz`'s wall clock with its offset. */
export function isoInZone(ms, tz) {
  const w = wallFields(ms, tz);
  const off = offsetMinutes(ms, tz);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** 'YYYY-MM-DD' → { y, mo, d }, or null. */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const v = { y: +m[1], mo: +m[2], d: +m[3] };
  const check = new Date(Date.UTC(v.y, v.mo - 1, v.d));
  return check.getUTCMonth() === v.mo - 1 && check.getUTCDate() === v.d ? v : null;
}

/** 'YYYY-MM-DD' + n days. */
export function addDays(date, n) {
  const v = parseDate(date);
  const t = new Date(Date.UTC(v.y, v.mo - 1, v.d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Midnight starting `date` ('YYYY-MM-DD') in `tz`, as an instant. */
export const startOfDay = (date, tz) => zonedToUtc({ ...parseDate(date), h: 0 }, tz);

/** 0 = Sunday … 6 = Saturday, for 'YYYY-MM-DD'. */
export function weekday(date) {
  const v = parseDate(date);
  return new Date(Date.UTC(v.y, v.mo - 1, v.d)).getUTCDay();
}

/**
 * A date or time as the apps and voice tools send it → { ms, date?, allDay }:
 *   'YYYY-MM-DD'                      → all day (date), ms = its midnight in `tz`
 *   'YYYY-MM-DDTHH:MM[:SS]'           → wall time in `tz`
 *   with 'Z' or ±HH:MM                → that instant
 * Throws a 400 on anything else.
 */
export function parseWhen(input, tz) {
  const s = String(input ?? '').trim();
  const date = parseDate(s);
  if (date) return { ms: startOfDay(s, tz), date: s, allDay: true };
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) throw Object.assign(new Error(`Not a date or time: "${s.slice(0, 40)}" (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)`), { status: 400 });
  const [, y, mo, d, h, mi, sec = '0', zone] = m;
  if (!parseDate(`${y}-${mo}-${d}`) || +h > 23 || +mi > 59) throw Object.assign(new Error(`Not a valid date or time: "${s}"`), { status: 400 });
  if (zone) {
    const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${pad(+sec)}${zone.toUpperCase() === 'Z' ? 'Z' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`);
    if (!Number.isFinite(ms)) throw Object.assign(new Error(`Not a valid time: "${s}"`), { status: 400 });
    return { ms, allDay: false };
  }
  return { ms: zonedToUtc({ y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +sec }, tz), allDay: false };
}

// Outlook / Exchange publish Windows zone names (CLDR windowsZones, territory 001).
const WINDOWS_ZONES = {
  'Dateline Standard Time': 'Etc/GMT+12', 'UTC-11': 'Etc/GMT+11', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage', 'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana', 'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver', 'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago', 'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina', 'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time': 'America/New_York', 'Eastern Standard Time (Mexico)': 'America/Cancun',
  'US Eastern Standard Time': 'America/Indianapolis', 'Venezuela Standard Time': 'America/Caracas',
  'Atlantic Standard Time': 'America/Halifax', 'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago', 'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo', 'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Buenos_Aires', 'Montevideo Standard Time': 'America/Montevideo',
  'Bahia Standard Time': 'America/Bahia', 'Tocantins Standard Time': 'America/Araguaina',
  'Central Brazilian Standard Time': 'America/Cuiaba', 'UTC-02': 'Etc/GMT+2', 'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde', UTC: 'Etc/UTC', 'Coordinated Universal Time': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris', 'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos', 'Morocco Standard Time': 'Africa/Casablanca',
  'GTB Standard Time': 'Europe/Bucharest', 'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev', 'Middle East Standard Time': 'Asia/Beirut', 'Egypt Standard Time': 'Africa/Cairo',
  'South Africa Standard Time': 'Africa/Johannesburg', 'Israel Standard Time': 'Asia/Jerusalem',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad', 'Turkey Standard Time': 'Europe/Istanbul',
  'Arabic Standard Time': 'Asia/Baghdad', 'Arab Standard Time': 'Asia/Riyadh', 'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi', 'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai',
  'Azerbaijan Standard Time': 'Asia/Baku', 'Georgian Standard Time': 'Asia/Tbilisi', 'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul', 'West Asia Standard Time': 'Asia/Tashkent', 'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata', 'Sri Lanka Standard Time': 'Asia/Colombo', 'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty', 'Bangladesh Standard Time': 'Asia/Dhaka', 'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei', 'W. Australia Standard Time': 'Australia/Perth', 'Korea Standard Time': 'Asia/Seoul',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin', 'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart', 'New Zealand Standard Time': 'Pacific/Auckland',
  'Fiji Standard Time': 'Pacific/Fiji', 'Tonga Standard Time': 'Pacific/Tongatapu',
};

/**
 * The IANA zone a calendar's TZID means, or null: 'Europe/Paris', '"Europe/Paris"',
 * '/mozilla.org/20050126_1/Europe/Paris', 'W. Europe Standard Time', '(UTC+01:00) Amsterdam…'.
 */
export function ianaZone(tzid) {
  if (!tzid) return null;
  let s = String(tzid).trim().replace(/^"+|"+$/g, '');
  if (isValidZone(s) && /\//.test(s)) return s;
  if (WINDOWS_ZONES[s]) return WINDOWS_ZONES[s];
  const tail = /([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(s);
  if (tail && isValidZone(tail[1])) return tail[1];
  s = s.replace(/^\(UTC[^)]*\)\s*/i, '');
  if (WINDOWS_ZONES[s]) return WINDOWS_ZONES[s];
  if (/^(UTC|GMT|Z|Etc\/UTC)$/i.test(s)) return 'Etc/UTC';
  return isValidZone(s) ? s : null;
}
