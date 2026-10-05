import React, { useEffect, useRef, useState } from 'react';

import { animate, motion } from 'framer-motion';

// Shared building blocks for the rich result cards (web): consistent surfaces,
// motion and number formatting. Cards only pass values they actually have.

export const EASE: [number, number, number, number] = [0.2, 0, 0, 1];

export const fmt = (n: number, maxDecimals = 2, minDecimals = 0) =>
  n.toLocaleString('en-US', { maximumFractionDigits: maxDecimals, minimumFractionDigits: minDecimals });
export const fmtUSD = (n: number) => `$${fmt(n, 2, n % 1 === 0 && Math.abs(n) >= 1000 ? 0 : 2)}`;
/** Prices always show cents: 195.1 → "195.10". */
export const fmtPrice = (n: number) => fmt(n, 2, 2);

export const palette = {
  accent: '#22D3EE',
  success: '#34D399',
  danger: '#EF4444',
  warning: '#FBBF24',
  violet: '#A855F7',
  indigo: '#818CF8',
  muted: '#7C8DA0',
};

/** Card surface: tinted gradient wash, a soft accent glow and an optional ambient scene behind the content. */
export const CardShell: React.FC<{ accent: string; gradient?: string; children: React.ReactNode; ambient?: React.ReactNode }> = ({ accent, gradient, children, ambient }) => (
  <motion.div
    initial={{ opacity: 0, y: 8, scale: 0.99 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    transition={{ duration: 0.35, ease: EASE }}
    className="w-full"
  >
    <div
      className="relative w-full overflow-hidden rounded-2xl border p-5 flex flex-col gap-5 font-sans normal-case tracking-normal leading-normal text-slate-100"
      style={{
        borderColor: `${accent}40`,
        background: gradient ?? `linear-gradient(135deg, ${accent}26 0%, #0A1522 55%, #060D17 100%)`,
      }}
    >
      <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full blur-2xl" style={{ background: accent, opacity: 0.14 }} />
      {ambient}
      <div className="relative flex flex-col gap-5">{children}</div>
    </div>
  </motion.div>
);

/** Staggered entrance for card sections. */
export const Reveal: React.FC<{ index?: number; className?: string; children: React.ReactNode }> = ({ index = 0, className, children }) => (
  <motion.div
    initial={{ opacity: 0, y: 14 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ type: 'spring', damping: 20, stiffness: 180, delay: 0.06 + index * 0.07 }}
    className={className}
  >
    {children}
  </motion.div>
);

/** Number that counts up to its value (ease-out, ~0.9 s). */
export const CountUp: React.FC<{ value: number; decimals?: number; minDecimals?: number; prefix?: string; suffix?: string; className?: string; duration?: number }> = ({
  value, decimals = 0, minDecimals = 0, prefix = '', suffix = '', className, duration = 0.9,
}) => {
  const [shown, setShown] = useState(0);
  // Live values glide from the last shown number instead of restarting at 0.
  const shownRef = useRef(0);
  useEffect(() => {
    const controls = animate(shownRef.current, value, { duration, ease: EASE, onUpdate: (v) => { shownRef.current = v; setShown(v); } });
    return () => controls.stop();
  }, [value, duration]);
  return <span className={`tabular-nums ${className ?? ''}`}>{prefix}{fmt(shown, decimals, minDecimals)}{suffix}</span>;
};

/** Horizontal bar that grows to `percent`. */
export const GrowBar: React.FC<{ percent: number; color: string; height?: number; delay?: number; track?: string }> = ({
  percent, color, height = 8, delay = 0.15, track = 'rgba(148,210,255,0.12)',
}) => (
  <div className="w-full overflow-hidden rounded-full" style={{ height, background: track }}>
    <motion.div
      className="h-full rounded-full"
      style={{ background: color }}
      initial={{ width: 0 }}
      animate={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      transition={{ duration: 0.7, ease: EASE, delay }}
    />
  </div>
);

/** Ring gauge that sweeps to `percent`, with the value in the middle. */
export const RingGauge: React.FC<{ percent: number; color: string; size?: number; stroke?: number }> = ({ percent, color, size = 108, stroke = 9 }) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent)) / 100;
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(148,210,255,0.12)" strokeWidth={stroke} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - p) }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.12 }}
        />
      </svg>
      <CountUp value={percent} suffix="%" className={size < 80 ? 'text-sm font-semibold' : 'text-xl font-semibold'} />
    </div>
  );
};

/** Line/area chart whose stroke draws in. Values plotted evenly left→right in a 100×40 viewBox. */
export const DrawLine: React.FC<{ values: number[]; color: string; area?: boolean; height?: number }> = ({ values, color, area = true, height = 150 }) => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * 100, 38 - ((v - min) / span) * 36]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full" style={{ height }}>
      {area && (
        <motion.path d={`${d} L100,40 L0,40 Z`} fill={color} initial={{ opacity: 0 }} animate={{ opacity: 0.2 }} transition={{ duration: 1, delay: 0.3 }} />
      )}
      <motion.path
        d={d}
        stroke={color}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 2.5 }}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, ease: EASE, delay: 0.15 }}
      />
    </svg>
  );
};

/** Small labelled value tile. */
export const Stat: React.FC<{ label: string; icon?: React.ReactNode; children: React.ReactNode }> = ({ label, icon, children }) => (
  <div className="flex flex-col gap-1 rounded-xl border border-white/10 bg-black/35 p-3 min-w-0">
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
      {icon}
      <span>{label}</span>
    </div>
    <div className="text-[17px] font-semibold tabular-nums truncate">{children}</div>
  </div>
);

export const StatGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>
);

/** Rounded status/label chip. */
export const Pill: React.FC<{ label: string; color: string; icon?: React.ReactNode }> = ({ label, color, icon }) => (
  <span
    className="inline-flex w-fit items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] font-bold"
    style={{ color, background: `${color}22`, borderColor: `${color}55` }}
  >
    {icon}
    {label}
  </span>
);

export const SectionLabel: React.FC<{ icon?: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
    {icon}
    <span>{children}</span>
  </div>
);
