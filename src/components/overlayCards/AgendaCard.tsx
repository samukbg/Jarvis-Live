import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { CalendarDays, CalendarPlus, ChevronDown, Clock, Coffee, Globe, MapPin, Settings, Sparkles, Video } from 'lucide-react';
import type { AgendaData, AgendaEvent } from './types';
import { CardShell, EASE, Reveal } from './kit';
import { LiveDot } from './motion';
import { useStore } from '../../store';
import {
  dayHeading, dayKey, deviceTimeZone, durationLabel, eventPhase, formatTime, formatTimeRange, groupByDay, meetingLink, nextUp,
  progressOf, rangeLabel, safeColor, validTimeZone, zoneCity, zoneOffsetLabel, type DayGroup,
} from '../../server/calendarFormat';

// The agenda card: what's on the user's calendars (Settings → Calendar) for a day, a week or a
// search, in the time zone the server answered in. Shows only the events it was given.

/** The card's own accent (= the Calendar label colour in SpecialCardRenderer). */
const AGENDA_ACCENT = '#FB7185';
const MAX_ROWS = 14;

/** Re-renders every 30 s so "in 25 min" and the now line stay true. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const colorOf = (e: AgendaEvent) => safeColor(e.color, AGENDA_ACCENT);

const JoinButton: React.FC<{ url?: string; compact?: boolean }> = ({ url, compact }) => {
  const link = meetingLink(url);
  if (!link) return null;
  return (
    <motion.a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      whileTap={{ scale: 0.95 }}
      onClick={(e) => e.stopPropagation()}
      className={`flex shrink-0 items-center gap-1.5 rounded-full font-semibold ${compact ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3.5 text-[12.5px]'}`}
      style={{ background: AGENDA_ACCENT, color: '#1A0710' }}
      title={link.href}
    >
      <Video size={compact ? 13 : 14} /> {link.label}
    </motion.a>
  );
};

/** The red "now" line between today's events. */
const NowLine: React.FC<{ label: string }> = ({ label }) => (
  <motion.div layout className="relative flex items-center gap-2 py-1" aria-label={`Now, ${label}`}>
    <span className="w-[54px] shrink-0 text-right text-[11px] font-bold tabular-nums" style={{ color: AGENDA_ACCENT }}>{label}</span>
    <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
      <motion.span className="absolute inset-0 rounded-full" style={{ background: AGENDA_ACCENT }} animate={{ scale: [1, 2.4], opacity: [0.6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }} />
      <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: AGENDA_ACCENT, boxShadow: `0 0 10px ${AGENDA_ACCENT}` }} />
    </span>
    <motion.span className="h-[2px] flex-1 origin-left rounded-full" style={{ background: `linear-gradient(90deg, ${AGENDA_ACCENT}, ${AGENDA_ACCENT}00)` }}
      initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.6, ease: EASE, delay: 0.25 }} />
  </motion.div>
);

const AllDayRow: React.FC<{ e: AgendaEvent; tz: string; highlight: boolean }> = ({ e, tz, highlight }) => {
  const color = colorOf(e);
  const span = formatTimeRange(e, tz);
  return (
    <div
      className="flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2"
      style={{ background: `${color}1A`, borderColor: highlight ? AGENDA_ACCENT : `${color}40`, boxShadow: highlight ? `0 0 0 1px ${AGENDA_ACCENT}, 0 0 22px ${AGENDA_ACCENT}40` : undefined }}
    >
      <span className="shrink-0 rounded-md px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-[0.08em]" style={{ background: `${color}33`, color }}>All day</span>
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-slate-100">{e.title}</span>
      {span !== 'All day' && <span className="hidden shrink-0 text-[11.5px] text-slate-400 sm:inline">{span.replace('All day · ', '')}</span>}
      {e.calendar && <span className="hidden max-w-[140px] shrink-0 truncate text-[11.5px] text-slate-500 sm:inline">{e.calendar}</span>}
    </div>
  );
};

const EventRow: React.FC<{ e: AgendaEvent; tz: string; now: number; isToday: boolean; highlight: boolean; index: number }> = ({ e, tz, now, isToday, highlight, index }) => {
  const color = colorOf(e);
  const s = Date.parse(e.start);
  const end = Date.parse(e.end || '');
  const phase = isToday ? eventPhase(e, tz, now) : 'upcoming';
  const past = phase === 'past';
  const live = phase === 'now';
  const dur = Number.isFinite(end) ? durationLabel(s, end) : '';
  const endTime = Number.isFinite(end) && end > s ? formatTime(end, tz) : '';
  const crossesDay = endTime && dayKey(s, tz) !== dayKey(end - 1, tz);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: past ? 0.5 : 1, x: 0 }}
      transition={{ type: 'spring', damping: 22, stiffness: 220, delay: Math.min(index, 10) * 0.035 }}
      className="relative flex min-w-0 items-stretch gap-2 rounded-xl py-2 pr-2"
      style={{
        background: highlight ? `${AGENDA_ACCENT}14` : live ? `${color}12` : undefined,
        boxShadow: highlight ? `inset 0 0 0 1px ${AGENDA_ACCENT}AA, 0 0 24px ${AGENDA_ACCENT}30` : undefined,
      }}
    >
      {/* Time column */}
      <div className="flex w-[54px] shrink-0 flex-col items-end pt-[1px] tabular-nums">
        <span className="text-[13.5px] font-semibold leading-tight" style={{ color: live ? color : '#E2E8F0' }}>{formatTime(s, tz)}</span>
        {endTime && <span className="text-[11px] leading-tight text-slate-500">{crossesDay ? '→ ' : ''}{endTime}</span>}
      </div>
      {/* Calendar colour bar */}
      <span className="relative w-[3px] shrink-0 overflow-hidden rounded-full" style={{ background: `${color}40` }}>
        <span className="absolute inset-x-0 top-0 rounded-full" style={{ height: live ? `${Math.max(8, progressOf(e, now) * 100)}%` : '100%', background: color, boxShadow: `0 0 8px ${color}80` }} />
      </span>
      <div className="min-w-0 flex-1 pl-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`min-w-0 max-w-full truncate text-[14.5px] font-semibold ${past ? 'text-slate-400' : 'text-slate-50'}`}>{e.title}</span>
          {live && (
            <span className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color, background: `${color}26` }}>
              <LiveDot color={color} size={5} /> Now
            </span>
          )}
          {highlight && (
            <span className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: AGENDA_ACCENT, background: `${AGENDA_ACCENT}26` }}>
              <Sparkles size={10} /> Just saved
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-slate-400">
          {dur && <span className="flex shrink-0 items-center gap-1"><Clock size={11} className="text-slate-500" />{dur}</span>}
          {e.location && <span className="flex min-w-0 max-w-full items-center gap-1"><MapPin size={11} className="shrink-0 text-slate-500" /><span className="truncate">{e.location}</span></span>}
          {e.calendar && <span className="flex min-w-0 items-center gap-1 text-slate-500"><span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} /><span className="truncate">{e.calendar}</span></span>}
        </div>
        {/* Phones: Join under the details, so the title keeps the width. */}
        {!past && e.meetingUrl && <div className="mt-1.5 flex sm:hidden"><JoinButton url={e.meetingUrl} compact /></div>}
      </div>
      {!past && e.meetingUrl && <div className="hidden shrink-0 items-center sm:flex"><JoinButton url={e.meetingUrl} compact /></div>}
    </motion.div>
  );
};

const Day: React.FC<{ g: DayGroup<AgendaEvent>; tz: string; now: number; highlightId?: string; showHeader: boolean; index: number; startIndex: number }> = ({ g, tz, now, highlightId, showHeader, index, startIndex }) => {
  const h = dayHeading(g.key, tz, now);
  const isToday = h.relative === 'today';
  const count = g.allDay.length + g.timed.length;
  // The now line goes before the first event still to start.
  const nowAt = isToday ? g.timed.findIndex((e) => Date.parse(e.start) > now) : -1;
  const nowIndex = isToday && g.timed.length ? (nowAt === -1 ? g.timed.length : nowAt) : -1;
  const nowLabel = formatTime(now, tz);
  return (
    <Reveal index={index} className="flex flex-col gap-1.5">
      {showHeader && (
        <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.07] pb-1.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-[13px] font-bold uppercase tracking-[0.12em]" style={{ color: isToday ? AGENDA_ACCENT : '#CBD5E1' }}>{h.label}</span>
            {h.relative && <span className="truncate text-[12px] text-slate-500">{h.date}</span>}
          </div>
          <span className="shrink-0 text-[11.5px] text-slate-500">{count} event{count === 1 ? '' : 's'}</span>
        </div>
      )}
      {g.allDay.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {g.allDay.map((e) => <AllDayRow key={`${g.key}-${e.id}`} e={e} tz={tz} highlight={e.id === highlightId} />)}
        </div>
      )}
      <div className="flex flex-col">
        {g.timed.map((e, i) => (
          <React.Fragment key={e.id || `${g.key}-${i}`}>
            {i === nowIndex && <NowLine label={nowLabel} />}
            <EventRow e={e} tz={tz} now={now} isToday={isToday} highlight={e.id === highlightId} index={startIndex + i} />
          </React.Fragment>
        ))}
        {nowIndex === g.timed.length && g.timed.length > 0 && <NowLine label={nowLabel} />}
      </div>
    </Reveal>
  );
};

/** Settings → Calendar, from the card's empty state. */
const openCalendarSettings = () => {
  const s = useStore.getState();
  s.dismissOutcome();
  s.openSettings('calendar');
};

const Empty: React.FC = () => (
  <CardShell accent={AGENDA_ACCENT}>
    <Reveal index={0} className="flex flex-col items-center gap-3 px-2 py-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl border" style={{ color: AGENDA_ACCENT, background: `${AGENDA_ACCENT}22`, borderColor: `${AGENDA_ACCENT}55`, boxShadow: `0 0 32px ${AGENDA_ACCENT}40` }}>
        <CalendarPlus size={26} />
      </div>
      <div className="text-[20px] font-semibold">Connect your calendar</div>
      <p className="max-w-md text-[14px] leading-relaxed text-slate-400">
        Add Google Calendar, iCloud or any calendar link. Then ask “What’s on tomorrow?” or “Add lunch with Ana on Friday at 1 pm”.
      </p>
      <motion.button
        type="button"
        whileTap={{ scale: 0.96 }}
        onClick={openCalendarSettings}
        className="mt-1 flex h-10 items-center gap-2 rounded-full px-5 text-[13px] font-semibold"
        style={{ background: AGENDA_ACCENT, color: '#1A0710' }}
      >
        <Settings size={15} /> Connect in Settings
      </motion.button>
    </Reveal>
  </CardShell>
);

export const AgendaCard: React.FC<{ data: AgendaData }> = ({ data }) => {
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  const tz = validTimeZone(data.timeZone) ?? deviceTimeZone();
  const events = useMemo(() => (Array.isArray(data.events) ? data.events : []).filter((e) => e && typeof e.title === 'string' && typeof e.start === 'string'), [data.events]);
  const groups = useMemo(() => groupByDay(events, tz, { from: data.from, to: data.to }), [events, tz, data.from, data.to]);

  if (data.empty) return <Empty />;

  const todayKey = dayKey(now, tz);
  const today = groups.find((g) => g.key === todayKey);
  // The banner: what comes next (the ongoing one already says NOW in the list), else what's on now.
  const next = today ? (nextUp(today.timed.filter((e) => Date.parse(e.start) > now), now) ?? nextUp(today.timed, now)) : null;
  const range = rangeLabel(data.from, data.to, tz, now);
  const title = data.title || 'Agenda';
  const showDayHeaders = groups.length > 1 || (groups.length === 1 && !(title === dayHeading(groups[0].key, tz, now).label));
  const foreignZone = !!data.timeZone && validTimeZone(data.timeZone) && data.timeZone !== deviceTimeZone();

  // Long weeks fold after MAX_ROWS rows (the highlighted event's day always shows).
  let budget = expanded ? Infinity : MAX_ROWS;
  const shown: DayGroup<AgendaEvent>[] = [];
  let hidden = 0;
  for (const g of groups) {
    const rows = g.allDay.length + g.timed.length;
    const keep = g.allDay.some((e) => e.id === data.highlightId) || g.timed.some((e) => e.id === data.highlightId);
    if (budget > 0 || keep) { shown.push(g); budget -= rows; } else hidden += rows;
  }
  let rowIndex = 0;

  return (
    <CardShell accent={AGENDA_ACCENT}>
      {/* Header */}
      <Reveal index={0} className="flex items-start gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border" style={{ color: AGENDA_ACCENT, background: `${AGENDA_ACCENT}22`, borderColor: `${AGENDA_ACCENT}55`, boxShadow: `0 0 26px ${AGENDA_ACCENT}33` }}>
          <CalendarDays size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[12.5px] text-slate-400">
            {range && range !== title && <span>{range}</span>}
            {range && range !== title && <span className="text-slate-600">·</span>}
            <span>{events.length ? `${events.length} event${events.length === 1 ? '' : 's'}` : 'Nothing planned'}</span>
            {foreignZone && (
              <span className="flex items-center gap-1 text-slate-500" title={data.timeZone}>
                <span className="text-slate-600">·</span><Globe size={11} /> {zoneCity(data.timeZone!)} time ({zoneOffsetLabel(data.timeZone!, now)})
              </span>
            )}
          </div>
        </div>
      </Reveal>

      {/* Next up (today) */}
      {next && (
        <Reveal index={1}>
          <div className="relative flex min-w-0 flex-wrap items-center gap-3 overflow-hidden rounded-2xl border px-3.5 py-3 sm:flex-nowrap"
            style={{ borderColor: `${AGENDA_ACCENT}55`, background: `linear-gradient(120deg, ${AGENDA_ACCENT}2E 0%, ${AGENDA_ACCENT}0D 70%)` }}>
            <div className="flex shrink-0 flex-col items-start">
              <span className="text-[10.5px] font-bold uppercase tracking-[0.14em]" style={{ color: AGENDA_ACCENT }}>{next.phase === 'now' ? 'Happening' : 'Next'}</span>
              <span className="flex items-center gap-1.5 text-[17px] font-semibold tabular-nums">
                {next.phase === 'now' && <LiveDot color={AGENDA_ACCENT} size={7} />}
                {next.phase === 'now' ? 'now' : next.label}
              </span>
            </div>
            <span className="h-9 w-px shrink-0 bg-white/10" />
            <div className="min-w-0 flex-1 basis-[140px]">
              <div className="truncate text-[14.5px] font-semibold">{next.event.title}</div>
              <div className="truncate text-[12px] text-slate-400">
                {formatTimeRange(next.event, tz)}
                {next.phase === 'now' && ` · ${next.label.replace(/^now · /, '')}`}
                {next.event.location ? ` · ${next.event.location}` : ''}
              </div>
            </div>
            {meetingLink(next.event.meetingUrl) && <div className="flex w-full justify-end sm:w-auto"><JoinButton url={next.event.meetingUrl} /></div>}
          </div>
        </Reveal>
      )}

      {/* Days */}
      {groups.length === 0 ? (
        <Reveal index={1} className="flex flex-col items-center gap-2 py-5 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-full" style={{ background: `${AGENDA_ACCENT}1F`, color: AGENDA_ACCENT }}><Coffee size={20} /></div>
          <div className="text-[15px] font-semibold">Nothing on your calendar</div>
          <div className="text-[13px] text-slate-400">{/^search/i.test(title) ? 'No event matches that search.' : 'Your time is free.'}</div>
        </Reveal>
      ) : (
        <div className="flex flex-col gap-4">
          {shown.map((g, i) => {
            const start = rowIndex;
            rowIndex += g.timed.length;
            return <Day key={g.key} g={g} tz={tz} now={now} highlightId={data.highlightId} showHeader={showDayHeaders} index={i + (next ? 2 : 1)} startIndex={start} />;
          })}
        </div>
      )}

      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="-mt-1 flex w-fit items-center gap-1.5 self-center rounded-full border border-white/10 bg-black/30 px-3.5 py-1.5 text-[12.5px] font-semibold text-slate-300 hover:text-white">
          <ChevronDown size={14} /> Show {hidden} more
        </button>
      )}
    </CardShell>
  );
};
