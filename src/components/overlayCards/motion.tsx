import React, { useEffect, useId, useState } from 'react';
import { motion } from 'framer-motion';

const EASE: [number, number, number, number] = [0.2, 0, 0, 1];

// Motion layer for the result cards (web): ambient scenes, loading shimmer,
// live pulse and a scrubbable chart. Mirrors the mobile kit.

/** Pill tabs with a sliding selection. */
export function Segmented<K extends string>({ items, value, onChange, accent = '#22D3EE' }: { items: Array<{ key: K; label: string; icon?: React.ReactNode }>; value: K; onChange: (k: K) => void; accent?: string }) {
  const id = useId();
  return (
    <div className="relative flex w-full rounded-full border border-white/10 bg-black/40 p-0.5">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={`relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${value === it.key ? 'text-slate-900' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {value === it.key && (
            <motion.span layoutId={`seg-${id}`} className="absolute inset-0 -z-10 rounded-full" style={{ background: accent }} transition={{ type: 'spring', damping: 22, stiffness: 300 }} />
          )}
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ── Loading & live states ────────────────────────────────────────────────────
export const Shimmer: React.FC<{ className?: string }> = ({ className }) => (
  <div className={`relative overflow-hidden rounded-md bg-sky-200/[0.08] ${className ?? 'h-3 w-full'}`}>
    <motion.div
      className="absolute inset-0"
      style={{ background: 'linear-gradient(90deg, transparent, rgba(148,210,255,0.18), transparent)' }}
      initial={{ x: '-100%' }}
      animate={{ x: '100%' }}
      transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
    />
  </div>
);

export const LiveDot: React.FC<{ color?: string; size?: number }> = ({ color = '#EF4444', size = 8 }) => (
  <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
    <motion.span
      className="absolute inset-0 rounded-full"
      style={{ background: color }}
      animate={{ scale: [1, 2.8], opacity: [0.7, 0] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
    />
    <span className="relative inline-flex rounded-full" style={{ width: size, height: size, background: color }} />
  </span>
);

/** Where the card's real data came from; pulses while it is live. */
export const SourceFooter: React.FC<{ sources?: string[]; live?: boolean; loading?: boolean }> = ({ sources, live, loading }) => {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <Shimmer className="h-2.5 w-28" />
        <span>Fetching live data…</span>
      </div>
    );
  }
  if (!sources?.length) return null;
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-500">
      {live && <LiveDot size={6} />}
      <span>{live ? 'Live · ' : 'Data: '}{sources.join(' · ')}</span>
    </div>
  );
};

// ── Ambient weather scene ────────────────────────────────────────────────────
const seeded = (i: number, salt: number) => {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

const Cloud: React.FC<{ i: number; top: string; scale: number; opacity: number }> = ({ i, top, scale, opacity }) => (
  <motion.div
    className="absolute"
    style={{ top, opacity, scale }}
    initial={{ left: `${-30 + seeded(i, 9) * 60}%` }}
    animate={{ left: ['-40%', '110%'] }}
    transition={{ duration: 30 + i * 8, repeat: Infinity, ease: 'linear', delay: -seeded(i, 1) * 20 }}
  >
    <div className="relative h-14 w-36">
      <div className="absolute left-0 top-5 h-10 w-24 rounded-full bg-slate-200" />
      <div className="absolute left-5 top-0 h-12 w-16 rounded-full bg-slate-200" />
      <div className="absolute left-14 top-3 h-10 w-14 rounded-full bg-slate-200" />
    </div>
  </motion.div>
);

/** Animated sky for the reported condition, layered for parallax. */
export const AmbientSky: React.FC<{ code?: string }> = ({ code }) => {
  const rain = code === 'rain' || code === 'thunderstorm';
  const clouds = rain || code === 'cloudy' || code === 'night_cloudy' || code === 'snow' || code === 'fog';
  const night = code === 'night_clear' || code === 'night_cloudy';
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {code === 'sunny' && (
        <div className="absolute -right-16 -top-20 flex h-56 w-56 items-center justify-center">
          <motion.div className="absolute inset-0 rounded-full" style={{ background: 'radial-gradient(circle, rgba(252,211,77,0.35), transparent 65%)' }} animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 3.2, repeat: Infinity }} />
          <motion.div className="absolute inset-0" animate={{ rotate: 360 }} transition={{ duration: 60, repeat: Infinity, ease: 'linear' }}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="absolute left-1/2 top-0 h-full w-1 -translate-x-1/2 rounded bg-amber-200/10" style={{ transform: `rotate(${i * 22.5}deg)` }} />
            ))}
          </motion.div>
          <div className="h-24 w-24 rounded-full bg-amber-300/80 blur-[1px]" />
        </div>
      )}
      {night && (
        <div className="absolute inset-0">
          {Array.from({ length: 26 }, (_, i) => (
            <motion.span
              key={i}
              className="absolute rounded-full bg-indigo-100"
              style={{ left: `${seeded(i, 7) * 100}%`, top: `${seeded(i, 8) * 60}%`, width: 1.5 + seeded(i, 6) * 2, height: 1.5 + seeded(i, 6) * 2 }}
              animate={{ opacity: [0.15, 1, 0.15] }}
              transition={{ duration: 1.8 + seeded(i, 5) * 1.8, repeat: Infinity, delay: seeded(i, 4) * 2 }}
            />
          ))}
        </div>
      )}
      {clouds && (
        <div className="absolute inset-0">
          <Cloud i={0} top="2%" scale={1.3} opacity={code === 'fog' ? 0.16 : 0.1} />
          <Cloud i={1} top="22%" scale={0.9} opacity={0.08} />
          {code === 'fog' && <Cloud i={2} top="45%" scale={1.7} opacity={0.12} />}
        </div>
      )}
      {(rain || code === 'snow') && (
        <div className="absolute inset-0">
          {Array.from({ length: code === 'snow' ? 30 : 42 }, (_, i) => (
            <motion.span
              key={i}
              className={code === 'snow' ? 'absolute h-1.5 w-1.5 rounded-full bg-slate-50' : 'absolute h-4 w-px rounded bg-cyan-200'}
              style={{ left: `${seeded(i, 1) * 100}%`, rotate: code === 'snow' ? 0 : 12 }}
              initial={{ top: '-8%', opacity: 0 }}
              animate={code === 'snow'
                ? { top: ['-8%', '108%'], x: [0, 10, -8, 0], opacity: [0, 0.9, 0.9, 0] }
                : { top: ['-8%', '108%'], x: [0, -18], opacity: [0, 0.55, 0.55, 0] }}
              transition={{ duration: code === 'snow' ? 5 + seeded(i, 2) * 3 : 0.7 + seeded(i, 2) * 0.5, repeat: Infinity, ease: 'linear', delay: seeded(i, 3) * 3 }}
            />
          ))}
        </div>
      )}
      {code === 'thunderstorm' && (
        <motion.div
          className="absolute inset-0 bg-indigo-100"
          animate={{ opacity: [0, 0, 0.55, 0.05, 0.4, 0] }}
          transition={{ duration: 5, repeat: Infinity, times: [0, 0.84, 0.86, 0.88, 0.9, 1] }}
        />
      )}
    </div>
  );
};

// ── Charts ───────────────────────────────────────────────────────────────────
/** Line + gradient area that draws in; hover / drag to scrub. `onScrub` reports the index (null on leave). */
export const ScrubChart: React.FC<{
  values: number[];
  color: string;
  height?: number;
  onScrub?: (index: number | null) => void;
  baseline?: number;
  interactive?: boolean;
}> = ({ values, color, height = 170, onScrub, baseline, interactive = true }) => {
  const [idx, setIdx] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');
  const W = 100;
  const H = 40;
  const min = Math.min(...values, baseline ?? Infinity);
  const max = Math.max(...values, baseline ?? -Infinity);
  const span = max - min || 1;
  const X = (i: number) => (i / Math.max(1, values.length - 1)) * W;
  const Y = (v: number) => 2 + (1 - (v - min) / span) * (H - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(2)},${Y(v).toFixed(2)}`).join(' ');
  const last = values.length - 1;
  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(last, Math.round(((e.clientX - r.left) / r.width) * last)));
    setIdx(i);
    onScrub?.(i);
  };
  const leave = () => { setIdx(null); onScrub?.(null); };
  const cur = idx ?? last;
  return (
    <div
      className={`relative w-full ${interactive ? 'cursor-crosshair touch-none' : 'pointer-events-none'}`}
      style={{ height }}
      onPointerMove={interactive ? pick : undefined}
      onPointerDown={interactive ? pick : undefined}
      onPointerLeave={interactive ? leave : undefined}
      onPointerUp={interactive ? (e) => { if (e.pointerType !== 'mouse') leave(); } : undefined}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity={0.35} />
            <stop offset="1" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {baseline !== undefined && (
          <line x1={0} x2={W} y1={Y(baseline)} y2={Y(baseline)} stroke="rgba(226,242,255,0.25)" strokeDasharray="1 1.5" vectorEffect="non-scaling-stroke" />
        )}
        <clipPath id={`c${gid}`}>
          {/* Reveal left→right; pathLength dashes break with non-scaling strokes. */}
          <motion.rect key={`r${d.length}`} x={0} y={-4} height={H + 8} initial={{ width: 0 }} animate={{ width: W + 2 }} transition={{ duration: 1, ease: EASE, delay: 0.12 }} />
        </clipPath>
        <g clipPath={`url(#c${gid})`}>
          <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#g${gid})`} />
          {/* Glow: a wide soft stroke under the line. */}
          <path d={d} stroke={color} strokeOpacity={0.25} fill="none" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 9, filter: `drop-shadow(0 0 6px ${color})` }} />
          <path d={d} stroke={color} fill="none" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 2.4 }} />
        </g>
        {idx !== null && <line x1={X(idx)} x2={X(idx)} y1={0} y2={H} stroke="rgba(226,242,255,0.5)" vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* Dots in HTML so they stay round under the stretched viewBox. */}
      <span className="pointer-events-none absolute" style={{ left: `${X(cur)}%`, top: `${(Y(values[cur]) / H) * 100}%`, transform: 'translate(-50%, -50%)' }}>
        {idx === null ? (
          <span className="relative flex h-2.5 w-2.5">
            <motion.span className="absolute inset-0 rounded-full" style={{ background: color }} animate={{ scale: [1, 3], opacity: [0.5, 0] }} transition={{ duration: 1.4, repeat: Infinity }} />
            <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: color }} />
          </span>
        ) : (
          <span className="block h-3.5 w-3.5 rounded-full border-[2.5px] bg-[#02060C]" style={{ borderColor: color }} />
        )}
      </span>
    </div>
  );
};

/** Donut whose segments sweep in one after another. */
export const Donut: React.FC<{ values: number[]; colors: string[]; size?: number; stroke?: number; children?: React.ReactNode; onSelect?: (i: number) => void }> = ({
  values, colors, size = 150, stroke = 16, children, onSelect,
}) => {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="relative flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(148,210,255,0.12)" strokeWidth={stroke} fill="none" />
        {values.map((v, i) => {
          const frac = Math.max(0, v) / total;
          const start = acc;
          acc += frac;
          const gap = frac > 0.02 ? 2 : 0;
          return (
            <motion.circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              stroke={colors[i % colors.length]}
              strokeWidth={stroke}
              fill="none"
              transform={`rotate(${start * 360} ${size / 2} ${size / 2})`}
              style={{ cursor: onSelect ? 'pointer' : undefined }}
              initial={{ strokeDasharray: `0 ${c}` }}
              animate={{ strokeDasharray: `${Math.max(0, frac * c - gap)} ${c}` }}
              transition={{ duration: 0.7, ease: EASE, delay: 0.15 + start * 0.9 }}
              whileHover={{ strokeWidth: stroke + 4 }}
              onClick={onSelect ? () => onSelect(i) : undefined}
            />
          );
        })}
      </svg>
      <div className="relative flex flex-col items-center">{children}</div>
    </div>
  );
};

/** Bars that glide to new values as live readings arrive (e.g. per-core CPU load). */
export const Equalizer: React.FC<{ values: number[]; color: (v: number) => string; height?: number }> = ({ values, color, height = 56 }) => (
  <div className="flex items-end gap-[3px]" style={{ height }}>
    {values.map((v, i) => (
      <div key={i} className="relative h-full flex-1 overflow-hidden rounded bg-sky-200/[0.07]">
        <motion.div
          className="absolute bottom-0 w-full rounded"
          style={{ background: color(v) }}
          initial={{ height: 0 }}
          animate={{ height: `${Math.max(3, Math.min(100, v))}%` }}
          transition={{ duration: 0.6, ease: EASE, delay: i * 0.025 }}
        />
      </div>
    ))}
  </div>
);

/** Keeps the last `max` readings of a live value, for sparklines built from real samples. */
export function useSamples(value: number | undefined, max = 30) {
  const [samples, setSamples] = useState<number[]>([]);
  useEffect(() => {
    if (value === undefined || !Number.isFinite(value)) return;
    setSamples((s) => [...s.slice(-(max - 1)), value]);
  }, [value, max]);
  return samples;
}
