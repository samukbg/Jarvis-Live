// The calendar for the voice models and the screens: the tools (the orb's Live session, OpenAI
// Realtime, the live avatar), date ranges as people say them ("tomorrow", "next week",
// "Friday"), the agenda card (AgendaData, src/components/overlayCards/types.ts) and the text
// the model speaks from.
import { addDays, dateInZone, parseWhen, startOfDay, weekday, wallFields, isoInZone } from './tz.js';

export const AGENDA_TOOL = {
  name: 'calendar_agenda',
  description:
    "Reads the user's calendars (the ones connected in Settings → Calendar: Google, iCloud, Outlook links, their phone's) " +
    'and shows the agenda on their screen. Returns the events (each with a ref like [e3] for changing it) and the current ' +
    'date and time. Use it for any question about their schedule, meetings, appointments or free time.',
  parameters: {
    type: 'OBJECT',
    properties: {
      day: {
        type: 'STRING',
        description: "The range in words: 'today', 'tomorrow', 'yesterday', 'this week', 'next week', 'this weekend', 'next 7 days', 'this month', 'next month', a weekday ('friday') or a date (YYYY-MM-DD). Default: today.",
      },
      from: { type: 'STRING', description: 'Optional explicit start: YYYY-MM-DD or YYYY-MM-DDTHH:MM (user’s local time).' },
      to: { type: 'STRING', description: 'Optional explicit end (exclusive): YYYY-MM-DD or YYYY-MM-DDTHH:MM.' },
      query: { type: 'STRING', description: 'Optional words to find events by title, place or notes ("dentist", "Ana"); searches the next 60 days when no range is given.' },
      show: { type: 'BOOLEAN', description: 'Show the agenda card on screen (default true).' },
    },
  },
};

export const ADD_EVENT_TOOL = {
  name: 'calendar_add_event',
  description:
    "Adds an event to the user's calendar (their default calendar, or the one named) and shows it on screen. Times are the " +
    "user's local time. Returns what was added and any clash with other events.",
  parameters: {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING', description: 'The event title, short ("Lunch with Ana", "Dentist").' },
      start: { type: 'STRING', description: 'Local start: YYYY-MM-DDTHH:MM, or YYYY-MM-DD for an all-day event.' },
      end: { type: 'STRING', description: 'Optional local end (YYYY-MM-DDTHH:MM, or the last day YYYY-MM-DD for all-day).' },
      durationMinutes: { type: 'NUMBER', description: 'Optional length when no end is given (default 60).' },
      location: { type: 'STRING', description: 'Optional place or address.' },
      notes: { type: 'STRING', description: 'Optional notes.' },
      calendar: { type: 'STRING', description: 'Optional calendar name ("Work", "Family") when the user names one.' },
    },
    required: ['title', 'start'],
  },
};

export const UPDATE_EVENT_TOOL = {
  name: 'calendar_update_event',
  description: "Moves, renames or changes an event in the user's calendar. Identify it by its ref from calendar_agenda ([e3]) or by words of its title.",
  parameters: {
    type: 'OBJECT',
    properties: {
      event: { type: 'STRING', description: 'The ref ("e3") or words of the title ("dentist").' },
      start: { type: 'STRING', description: 'New local start (YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all-day). The length stays the same unless end/durationMinutes is given.' },
      end: { type: 'STRING', description: 'New local end.' },
      durationMinutes: { type: 'NUMBER', description: 'New length in minutes.' },
      title: { type: 'STRING', description: 'New title.' },
      location: { type: 'STRING', description: 'New place ("" removes it).' },
    },
    required: ['event'],
  },
};

export const DELETE_EVENT_TOOL = {
  name: 'calendar_delete_event',
  description: "Deletes an event from the user's calendar. Only with confirmed=true, after the user said yes to deleting that exact event.",
  parameters: {
    type: 'OBJECT',
    properties: {
      event: { type: 'STRING', description: 'The ref ("e3") or words of the title.' },
      confirmed: { type: 'BOOLEAN', description: 'true only after the user confirmed.' },
    },
    required: ['event'],
  },
};

export const CALENDAR_TOOLS = [AGENDA_TOOL, ADD_EVENT_TOOL, UPDATE_EVENT_TOOL, DELETE_EVENT_TOOL];

/** Where the live avatar posts each tool's arguments (calendar/routes.js). */
export const CALENDAR_TOOL_PATHS = CALENDAR_TOOLS.map((t) => `/api/calendar/tool/${t.name}`);

/**
 * The coming days in a few lines for the voice model's context: every day (free ones too), each
 * event's time, title and place. No refs: changing an event goes through calendar_agenda first.
 */
export function agendaDigest(events, { tz, now = Date.now(), days = 7, maxEvents = 40 } = {}) {
  const today = dateInZone(now, tz);
  const byDay = new Map();
  for (let i = 0; i < days; i++) byDay.set(addDays(today, i), []);
  let shown = 0;
  let more = 0;
  for (const e of events) {
    const first = e.allDay ? e.start : e.start.slice(0, 10);
    const last = e.allDay && e.end ? addDays(e.end, -1) : first;
    for (const d of byDay.keys()) {
      if (d < first || d > last) continue;
      if (shown >= maxEvents) { more++; continue; }
      const place = e.location && !/^https?:\/\//i.test(e.location) ? ` @ ${e.location.slice(0, 40)}` : '';
      byDay.get(d).push(`${timeLabel(e.allDay ? { ...e, allDay: true } : e)} ${e.title.slice(0, 60)}${place}${e.meetingUrl ? ' (video)' : ''}`);
      shown++;
    }
  }
  const lines = [...byDay].map(([d, list]) => `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00Z`))}: ${list.length ? list.join('; ') : 'nothing'}`);
  if (more) lines.push(`(${more} more not listed)`);
  return lines.join('\n');
}

/**
 * Added to the Live instruction wherever the tools are declared. `now`/`tz`: today's date for
 * relative days; `digest`: the coming days (agendaDigest), when the user shares them with the voice.
 */
export function calendarPrompt({ now = Date.now(), tz, digest = null } = {}) {
  const today = tz ? `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(now))} (${tz})` : null;
  return (
    "The user's calendars are connected to you. For their schedule (\"What's on today?\", \"Am I free Friday afternoon?\", " +
    '"When is my dentist?") call `calendar_agenda`; to add an event call `calendar_add_event`; to move or rename one, ' +
    '`calendar_update_event`; to delete one, first say which event and ask the user to confirm, then call ' +
    '`calendar_delete_event` with confirmed=true. Use the user\'s local times (YYYY-MM-DDTHH:MM). Answer in one or two ' +
    'short sentences in their language: the next or most relevant events, not every detail — the agenda is on screen. ' +
    'Never read refs like [e3] out loud. If a tool says no calendar is connected, tell the user they can connect one in ' +
    'Settings → Calendar.' +
    (today ? ` Today is ${today}.` : '') +
    (digest
      ? `\n\nThe user's calendar for the next 7 days (times in ${tz}). Answer questions about these days from it directly ` +
        '(what is on, when they are free or busy, when they see someone, how their week looks); call `calendar_agenda` for ' +
        'other dates, searches, details, or to get an event\'s ref before changing it:\n' + digest
      : '')
  );
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const dayTitle = (date, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));

/**
 * A range as the tools and the apps ask for it → { fromMs, toMs, title }. `day` words, a date,
 * or from/to (dates or local times). Weeks start on Monday.
 */
export function resolveRange({ day, from, to, range } = {}, { tz, now = Date.now() } = {}) {
  const today = dateInZone(now, tz);
  if (from || to) {
    const f = from ? parseWhen(from, tz) : { ms: now };
    let t = to ? parseWhen(to, tz) : null;
    if (t?.allDay && to && from && t.ms <= f.ms) t = { ms: f.ms + 86400_000 };
    const toMs = t ? t.ms : f.allDay ? startOfDay(addDays(dateInZone(f.ms, tz), 1), tz) : f.ms + 7 * 86400_000;
    if (toMs <= f.ms) throw bad('The end must be after the start');
    const title = f.allDay && toMs - f.ms <= 86400_000 + 3600_000 ? dayTitle(dateInZone(f.ms, tz), tz) : `${dayTitle(dateInZone(f.ms, tz), tz)} – ${dayTitle(dateInZone(toMs - 1, tz), tz)}`;
    return { fromMs: f.ms, toMs, title };
  }
  const words = String(day || range || 'today').trim().toLowerCase().replace(/_/g, ' ');
  const span = (startDate, days, title) => ({ fromMs: startOfDay(startDate, tz), toMs: startOfDay(addDays(startDate, days), tz), title });
  const mondayOf = (date) => addDays(date, -((weekday(date) + 6) % 7));
  if (/^\d{4}-\d{2}-\d{2}$/.test(words)) return span(words, 1, dayTitle(words, tz));
  switch (words) {
    case 'today': return span(today, 1, 'Today');
    case 'tomorrow': return span(addDays(today, 1), 1, 'Tomorrow');
    case 'yesterday': return span(addDays(today, -1), 1, 'Yesterday');
    case 'day after tomorrow': return span(addDays(today, 2), 1, dayTitle(addDays(today, 2), tz));
    case 'week': case 'this week': {
      // The rest of this week: from now (today's earlier events stay, they're today's).
      const mon = mondayOf(today);
      return { fromMs: startOfDay(today, tz), toMs: startOfDay(addDays(mon, 7), tz), title: 'This week' };
    }
    case 'next week': return span(addDays(mondayOf(today), 7), 7, 'Next week');
    case 'weekend': case 'this weekend': {
      const sat = addDays(today, (6 - weekday(today) + 7) % 7);
      const start = weekday(today) === 0 ? addDays(today, -1) : sat;
      return span(start, 2, 'This weekend');
    }
    case 'next weekend': return span(addDays(today, ((6 - weekday(today) + 7) % 7) + 7), 2, 'Next weekend');
    case 'next 7 days': case 'coming up': case 'upcoming': return { fromMs: startOfDay(today, tz), toMs: startOfDay(addDays(today, 7), tz), title: 'Next 7 days' };
    case 'month': case 'this month': {
      const w = wallFields(now, tz);
      const first = `${String(w.y).padStart(4, '0')}-${String(w.mo).padStart(2, '0')}-01`;
      const next = w.mo === 12 ? `${w.y + 1}-01-01` : `${String(w.y).padStart(4, '0')}-${String(w.mo + 1).padStart(2, '0')}-01`;
      return { fromMs: startOfDay(today, tz), toMs: startOfDay(next, tz), title: new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(`${first}T12:00:00Z`)) };
    }
    case 'next month': {
      const w = wallFields(now, tz);
      const y = w.mo === 12 ? w.y + 1 : w.y;
      const mo = w.mo === 12 ? 1 : w.mo + 1;
      const first = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-01`;
      const after = mo === 12 ? `${y + 1}-01-01` : `${String(y).padStart(4, '0')}-${String(mo + 1).padStart(2, '0')}-01`;
      return { fromMs: startOfDay(first, tz), toMs: startOfDay(after, tz), title: new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(`${first}T12:00:00Z`)) };
    }
    default: {
      const wd = WEEKDAYS.findIndex((w) => words === w || words === `next ${w}` || words === `this ${w}` || words === `on ${w}`);
      if (wd >= 0) {
        let delta = (wd - weekday(today) + 7) % 7;
        if (words.startsWith('next ') && delta === 0) delta = 7;
        const date = addDays(today, delta);
        return span(date, 1, delta === 0 ? 'Today' : delta === 1 ? 'Tomorrow' : dayTitle(date, tz));
      }
      throw bad(`Unknown day "${String(day).slice(0, 40)}": use today, tomorrow, this week, next week, a weekday or YYYY-MM-DD`);
    }
  }
}

const hhmm = (iso) => iso.slice(11, 16);

/** "09:30–10:00" / "all day" / "from 22:00" for an event in its ISO form. */
export function timeLabel(ev) {
  if (ev.allDay) return 'all day';
  const s = hhmm(ev.start);
  const e = ev.end && ev.end.slice(0, 10) === ev.start.slice(0, 10) ? hhmm(ev.end) : null;
  return e && e !== s ? `${s}–${e}` : s;
}

/** The agenda card's data. `events`: the public CalendarEvents of the range. */
export function agendaData(events, { title, fromMs, toMs, tz, highlightId, empty } = {}) {
  const list = events.slice(0, 40).map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    ...(e.end ? { end: e.end } : {}),
    ...(e.allDay ? { allDay: true } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.calendarName ? { calendar: e.calendarName } : {}),
    ...(e.color ? { color: e.color } : {}),
    ...(e.meetingUrl ? { meetingUrl: e.meetingUrl } : {}),
  }));
  return {
    title: title || 'Agenda',
    from: isoInZone(fromMs, tz),
    to: isoInZone(toMs, tz),
    timeZone: tz,
    events: list,
    ...(highlightId ? { highlightId } : {}),
    ...(empty ? { empty: true } : {}),
  };
}

/** One sentence for the card's text and history. */
export function agendaSummary(data) {
  if (data.empty) return 'No calendar is connected yet — connect one in Settings → Calendar.';
  const n = data.events.length;
  const when = data.title.toLowerCase() === 'today' || data.title.toLowerCase() === 'tomorrow' ? data.title.toLowerCase() : data.title;
  if (!n) return `Nothing on the calendar ${/^(today|tomorrow)$/.test(when) ? when : `for ${when}`}.`;
  return `${n} event${n === 1 ? '' : 's'} ${/^(today|tomorrow)$/.test(when) ? when : `for ${when}`}.`;
}

/** The agent_result text: the sentence, then the card as a fenced JSON block. */
export function agendaText(data) {
  const summary = agendaSummary(data);
  return `${summary}\n\n\`\`\`json\n${JSON.stringify({ type: 'agenda', summary, data })}\n\`\`\``;
}

/**
 * Plain text for the voice model: now, then the events grouped by day with refs. `refOf(ev)`
 * gives an event's short ref ('e3').
 */
export function spokenAgenda(events, { title, tz, now = Date.now(), refOf = () => null, total = events.length, query } = {}) {
  const nowLine = `Now: ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now))} (${tz}).`;
  if (!events.length) return `${nowLine} ${query ? `No events match "${query}"` : `No events ${title ? `(${title})` : ''}`} in the user's calendars.`.replace(/\s+/g, ' ');
  const byDay = new Map();
  for (const e of events.slice(0, 60)) {
    const d = e.allDay ? e.start : e.start.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  const lines = [nowLine, `${title || 'Agenda'}${query ? ` matching "${query}"` : ''}:`];
  for (const [d, list] of byDay) {
    const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${d}T12:00:00Z`));
    lines.push(`${label}:`);
    for (const e of list) {
      const ref = refOf(e);
      const extras = [e.location && !/^https?:\/\//i.test(e.location) && `at ${e.location}`, e.meetingUrl && 'video call', e.calendarName && `(${e.calendarName})`, e.status === 'tentative' && 'tentative'].filter(Boolean).join(' ');
      lines.push(`- ${timeLabel(e)} ${e.title}${extras ? ` ${extras}` : ''}${ref ? ` [${ref}]` : ''}`);
    }
  }
  if (total > events.length || events.length > 60) lines.push(`(${total - Math.min(events.length, 60)} more not listed)`);
  const next = events.find((e) => !e.allDay && Date.parse(e.start) > now);
  if (next) {
    const mins = Math.round((Date.parse(next.start) - now) / 60000);
    if (mins <= 180) lines.push(`Next: "${next.title}" in ${mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`}.`);
  }
  return lines.join('\n');
}
