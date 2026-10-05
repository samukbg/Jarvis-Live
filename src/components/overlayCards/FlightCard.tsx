import React from 'react';
import { motion } from 'framer-motion';
import { Plane, CheckCircle2, AlertTriangle, XCircle, Clock, ArrowUpRight, Gauge, Navigation, PlaneTakeoff, PlaneLanding, Cog } from 'lucide-react';
import type { FlightData } from './types';
import type { CardLive } from './enrichment';
import { CardShell, EASE, Pill, Reveal, Stat, StatGrid, palette } from './kit';
import { LiveDot } from './motion';

const STATUS_COLOR: Record<string, string> = {
  'ON TIME': palette.success, 'IN FLIGHT': palette.accent, LANDED: palette.success, BOARDING: palette.warning,
  SCHEDULED: palette.indigo, DELAYED: palette.warning, CANCELLED: palette.danger,
};
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** Rotating radar sweep behind the card (ambient). */
const Radar: React.FC<{ color: string }> = ({ color }) => (
  <div className="pointer-events-none absolute -right-20 -top-16 h-64 w-64">
    {[1, 0.7, 0.4].map((s) => (
      <div key={s} className="absolute inset-0 rounded-full border" style={{ borderColor: `${color}22`, transform: `scale(${s})` }} />
    ))}
    <motion.div
      className="absolute inset-0 rounded-full"
      style={{ background: `conic-gradient(from 0deg, ${color}38, transparent 25%)` }}
      animate={{ rotate: 360 }}
      transition={{ duration: 6, repeat: Infinity, ease: 'linear' }}
    />
  </div>
);

/** Curved route with the plane at the real progress (or where the stated status puts it). */
const RouteArc: React.FC<{ progress?: number; status?: FlightData['status']; color: string }> = ({ progress, status, color }) => {
  const t = progress !== undefined ? progress / 100 : status === 'LANDED' ? 1 : status === 'IN FLIGHT' ? 0.5 : 0;
  const W = 300;
  const H = 72;
  const p0 = { x: 8, y: H - 8 };
  const p1 = { x: W / 2, y: -H * 0.55 };
  const p2 = { x: W - 8, y: H - 8 };
  const at = (u: number) => ({
    x: (1 - u) ** 2 * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x,
    y: (1 - u) ** 2 * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y,
    a: (Math.atan2(2 * (1 - u) * (p1.y - p0.y) + 2 * u * (p2.y - p1.y), 2 * (1 - u) * (p1.x - p0.x) + 2 * u * (p2.x - p1.x)) * 180) / Math.PI,
  });
  // Keyframes along the curve so the plane follows the arc, not a straight line.
  const steps = Array.from({ length: 21 }, (_, i) => at((i / 20) * t));
  const d = `M${p0.x},${p0.y} Q${p1.x},${p1.y} ${p2.x},${p2.y}`;
  return (
    <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full overflow-visible">
        <path d={d} stroke={`${color}55`} strokeWidth={2} strokeDasharray="4 6" fill="none" />
        <motion.path d={d} stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: t }} transition={{ duration: 1.6, ease: EASE, delay: 0.25 }} />
        <circle cx={p0.x} cy={p0.y} r={5} fill={color} />
        <circle cx={p2.x} cy={p2.y} r={5} fill="#02060C" stroke={color} strokeWidth={2} />
      </svg>
      <motion.div
        className="absolute left-0 top-0"
        initial={{ left: `${(p0.x / W) * 100}%`, top: `${(p0.y / H) * 100}%`, rotate: steps[0].a + 45 }}
        animate={{ left: steps.map((s) => `${(s.x / W) * 100}%`), top: steps.map((s) => `${(s.y / H) * 100}%`), rotate: steps.map((s) => s.a + 45) }}
        transition={{ duration: 1.6, ease: EASE, delay: 0.25 }}
        style={{ translateX: '-50%', translateY: '-50%' }}
      >
        <motion.span className="block" animate={status === 'IN FLIGHT' ? { y: [-2.5, 2.5, -2.5] } : undefined} transition={{ duration: 2.2, repeat: Infinity }}>
          <Plane size={22} style={{ color, filter: `drop-shadow(0 0 8px ${color})` }} />
        </motion.span>
      </motion.div>
    </div>
  );
};

const Airport: React.FC<{ code: string; city?: string; airport?: string; align: 'left' | 'right' }> = ({ code, city, airport, align }) => (
  <div className={`flex max-w-[46%] flex-col ${align === 'left' ? 'items-start text-left' : 'items-end text-right'}`}>
    <span className="text-[32px] font-bold leading-none tracking-wide">{code}</span>
    {city && <span className="truncate text-[13px] text-slate-300">{city}</span>}
    {airport && <span className="line-clamp-2 text-[11px] text-slate-500">{airport}</span>}
  </div>
);

export const FlightCard: React.FC<{ data: FlightData; live?: CardLive }> = ({ data, live }) => {
  const color = data.status ? STATUS_COLOR[data.status] ?? palette.accent : palette.accent;
  const StatusIcon = data.status === 'CANCELLED' ? XCircle : data.status === 'DELAYED' ? AlertTriangle : data.status === 'IN FLIGHT' ? Plane : CheckCircle2;
  const side = (s: FlightData['origin'] | FlightData['destination'], kind: 'origin' | 'destination') => {
    const rows: Array<[string, string]> = [];
    if (s.terminal) rows.push(['Terminal', s.terminal]);
    if (s.gate) rows.push(['Gate', s.gate]);
    if ('baggage' in s && s.baggage) rows.push(['Baggage belt', s.baggage]);
    if (s.scheduledTime) rows.push([kind === 'origin' ? 'Departure' : 'Scheduled', s.scheduledTime]);
    if ('actualTime' in s && s.actualTime) rows.push(['Departed', s.actualTime]);
    if ('estimatedTime' in s && s.estimatedTime) rows.push(['Estimated arrival', s.estimatedTime]);
    return rows;
  };
  const dep = side(data.origin, 'origin');
  const arr = side(data.destination, 'destination');
  const lv = data.live;
  const telemetry: Array<[string, React.ReactNode, React.ReactNode]> = [];
  if (data.altitude) telemetry.push(['Altitude', data.altitude, <ArrowUpRight size={13} />]);
  if (data.speed) telemetry.push(['Ground speed', data.speed, <Gauge size={13} />]);
  if (lv?.heading !== undefined) {
    telemetry.push(['Heading', (
      <span className="flex items-center gap-2">
        <motion.span initial={{ rotate: lv.heading - 135 }} animate={{ rotate: lv.heading - 45 }} transition={{ type: 'spring', damping: 12, stiffness: 60 }}><Navigation size={15} style={{ color }} /></motion.span>
        {Math.round(lv.heading)}°
      </span>
    ), <Navigation size={13} />]);
  }
  if (lv?.verticalRateFpm !== undefined && Math.abs(lv.verticalRateFpm) >= 200) {
    telemetry.push([lv.verticalRateFpm > 0 ? 'Climbing' : 'Descending', `${Math.abs(lv.verticalRateFpm).toLocaleString('en-US')} ft/min`, lv.verticalRateFpm > 0 ? <PlaneTakeoff size={13} /> : <PlaneLanding size={13} />]);
  }
  if (data.duration) telemetry.push(['Duration', data.duration, <Clock size={13} />]);
  if (data.aircraft) telemetry.push(['Aircraft', data.registration ? `${data.aircraft} · ${data.registration}` : data.aircraft, <Cog size={13} />]);

  return (
    <CardShell accent={color} ambient={<Radar color={color} />}>
      {data.aircraftPhotoUrl && (
        <Reveal index={0} className="relative -mx-5 -mt-5 h-40 overflow-hidden">
          <div className="absolute -inset-4">
            <img src={data.aircraftPhotoUrl} alt="" className="h-full w-full object-cover" />
          </div>
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#02060C]/90" />
          {data.registration && <span className="absolute bottom-2 right-3 text-[11px] text-white/70">{data.registration}</span>}
        </Reveal>
      )}

      <div>
        <Reveal index={1} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[20px] font-semibold">{data.flightNumber}</div>
            {data.airline && <div className="text-[13px] text-slate-400">{data.airline}</div>}
          </div>
          {live?.live && <LiveDot color={color} size={7} />}
          {data.status && <Pill label={titleCase(data.status)} color={color} icon={<StatusIcon size={13} />} />}
        </Reveal>

        <Reveal index={2} className="mt-4 flex flex-col gap-1">
          <div className="flex justify-between">
            <Airport code={data.origin.code} city={data.origin.city} airport={data.origin.airport} align="left" />
            <Airport code={data.destination.code} city={data.destination.city} airport={data.destination.airport} align="right" />
          </div>
          <div>
            <RouteArc progress={data.progressPercent} status={data.status} color={color} />
          </div>
          {data.progressPercent !== undefined && <span className="text-center text-[11px] text-slate-500">{data.progressPercent}% of the route flown</span>}
        </Reveal>
      </div>

      {(dep.length > 0 || arr.length > 0) && (
        <Reveal index={3} className="grid grid-cols-2 gap-3">
          {[{ title: 'Departure', rows: dep }, { title: 'Arrival', rows: arr }].filter((c) => c.rows.length).map((c) => (
            <div key={c.title} className="flex flex-col gap-2 rounded-xl bg-black/35 p-3">
              <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{c.title}</span>
              {c.rows.map(([label, value]) => (
                <div key={label}>
                  <div className="text-[11px] text-slate-500">{label}</div>
                  <div className="text-[16px] font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </div>
          ))}
        </Reveal>
      )}

      {telemetry.length > 0 && (
        <Reveal index={4}>
          <StatGrid>
            {telemetry.map(([label, value, icon]) => <Stat key={label} label={label} icon={<span style={{ color }}>{icon}</span>}>{value}</Stat>)}
          </StatGrid>
        </Reveal>
      )}
    </CardShell>
  );
};
