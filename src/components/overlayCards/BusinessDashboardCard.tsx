import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight, Briefcase, ChartLine, ChevronLeft, ChevronRight, Clock, File as FileIcon, Folder, Globe, LayoutGrid, Settings,
  Sparkles, TrendingDown, TrendingUp, TriangleAlert, Minus,
} from 'lucide-react';
import type { BusinessDashboardData, BusinessKpi, BusinessOverview, BusinessTotals } from './types';
import { CardShell, CountUp, EASE, Pill, Reveal, RingGauge, SectionLabel, fmt, palette } from './kit';
import { ScrubChart } from './motion';
import { API_KEY, BACKEND_HTTP, useStore } from '../../store';
import {
  changeTone, countable, currencySymbol, displayLocation, initialOf, initialView, logoSrc, periodShort, portfolioLine, statusLabel, statusTone, timeAgo, toMs,
} from '../../server/businessFormat';

// The Business Dashboard: an overview of each project / business the user added in
// Settings → Businesses. Shows only what the analysis reported — nothing invented.

/** The card's own accent (= the Business label colour in SpecialCardRenderer). */
const BUSINESS_ACCENT = palette.indigo;

const TONE: Record<ReturnType<typeof statusTone>, string> = {
  success: palette.success,
  accent: palette.accent,
  warning: palette.warning,
  muted: palette.muted,
};
const toneOf = (b: BusinessOverview) => TONE[statusTone(b.status, b.health)];
const hasHealth = (b: BusinessOverview) => typeof b.health === 'number' && Number.isFinite(b.health);

const KindPill: React.FC<{ b: BusinessOverview }> = ({ b }) => {
  const file = (b.source as string) === 'file';
  const Icon = b.source === 'website' ? Globe : file ? FileIcon : Folder;
  return <Pill color={BUSINESS_ACCENT} icon={<Icon size={12} />} label={b.kind === 'business' ? 'Business' : 'Project'} />;
};

/** The business's logo, else a monogram tile in the accent colour. */
const Logo: React.FC<{ b: BusinessOverview; size?: number }> = ({ b, size = 52 }) => {
  const [broken, setBroken] = useState(false);
  const radius = Math.round(size * 0.26);
  const src = logoSrc(b.logoUrl, BACKEND_HTTP, API_KEY);
  if (src && !broken) {
    return (
      <div className="grid shrink-0 place-items-center overflow-hidden border border-white/15 bg-white" style={{ width: size, height: size, borderRadius: radius, boxShadow: `0 0 24px ${BUSINESS_ACCENT}26` }}>
        <img src={src} alt="" className="h-full w-full object-contain p-[12%]" onError={() => setBroken(true)} draggable={false} />
      </div>
    );
  }
  return (
    <div
      className="grid shrink-0 place-items-center border font-extrabold"
      style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.42), color: BUSINESS_ACCENT, background: `${BUSINESS_ACCENT}22`, borderColor: `${BUSINESS_ACCENT}55`, boxShadow: `0 0 24px ${BUSINESS_ACCENT}33` }}
    >
      {initialOf(b.name)}
    </div>
  );
};

/** Health ring + status word (or the status alone when there's no score). */
const Health: React.FC<{ b: BusinessOverview; size?: number }> = ({ b, size = 84 }) => {
  const color = toneOf(b);
  if (!hasHealth(b) && !b.status) return null;
  if (!hasHealth(b)) return <Pill color={color} label={statusLabel(b.status)} />;
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <RingGauge percent={Math.round(b.health!)} color={color} size={size} stroke={size < 70 ? 6 : 8} />
      {b.status && size >= 70 && <span className="text-[12px] font-semibold" style={{ color }}>{statusLabel(b.status)}</span>}
    </div>
  );
};

const TrendMark: React.FC<{ trend?: BusinessKpi['trend']; size?: number }> = ({ trend, size = 14 }) => {
  if (!trend) return null;
  const color = trend === 'up' ? palette.success : trend === 'down' ? palette.danger : palette.muted;
  const Icon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  return <Icon size={size} style={{ color }} className="shrink-0" aria-label={`trend ${trend}`} />;
};

const KpiValue: React.FC<{ value: string; className: string }> = ({ value, className }) => {
  const c = countable(value);
  return c ? <CountUp value={c.n} decimals={c.decimals} minDecimals={c.decimals} className={className} /> : <span className={`tabular-nums ${className}`}>{value}</span>;
};

const KpiTile: React.FC<{ kpi: BusinessKpi }> = ({ kpi }) => (
  <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-white/10 bg-black/35 p-3">
    <div className="truncate text-[11px] font-medium text-slate-400">{kpi.label}</div>
    <div className="flex min-w-0 items-center gap-1.5">
      <KpiValue value={kpi.value} className="truncate text-[19px] font-semibold" />
      <TrendMark trend={kpi.trend} />
    </div>
    {kpi.hint && <div className="truncate text-[11px] text-slate-500">{kpi.hint}</div>}
  </div>
);

const pointLabel = (t: number) => new Date(toMs(t)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const Activity: React.FC<{ activity: NonNullable<BusinessOverview['activity']>; color: string }> = ({ activity, color }) => {
  const [scrub, setScrub] = useState<number | null>(null);
  const pts = activity.points;
  const values = pts.map((p) => p.value);
  const i = scrub ?? pts.length - 1;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <SectionLabel icon={<ChartLine size={13} style={{ color }} />}>{activity.label}</SectionLabel>
        <div className="flex items-baseline gap-1.5 text-right">
          <span className="text-[17px] font-semibold tabular-nums">{fmt(values[i], 1)}</span>
          <span className="text-[11px] text-slate-500">{scrub === null ? 'latest' : pointLabel(pts[i].t)}</span>
        </div>
      </div>
      <ScrubChart values={values} color={color} height={120} onScrub={setScrub} />
      <div className="flex justify-between text-[11px] text-slate-500">
        <span>{pointLabel(pts[0].t)}</span>
        <span className="hidden sm:inline">Hover or drag to explore</span>
        <span>{pointLabel(pts[pts.length - 1].t)}</span>
      </div>
    </div>
  );
};

const LIST_META = {
  highlights: { title: 'Highlights', icon: Sparkles, color: palette.success },
  risks: { title: 'Risks', icon: TriangleAlert, color: '#FB923C' },
  nextSteps: { title: 'Next steps', icon: ArrowRight, color: palette.accent },
} as const;

const ListPanel: React.FC<{ kind: keyof typeof LIST_META; items: string[]; index: number }> = ({ kind, items, index }) => {
  const m = LIST_META[kind];
  const Icon = m.icon;
  return (
    <Reveal index={index} className="min-w-0">
      <div className="h-full rounded-xl border p-3.5" style={{ borderColor: `${m.color}2E`, background: `linear-gradient(160deg, ${m.color}14, rgba(0,0,0,0.25) 70%)` }}>
        <SectionLabel icon={<Icon size={13} style={{ color: m.color }} />}>{m.title}</SectionLabel>
        <ul className="flex flex-col gap-2">
          {items.map((text, i) => (
            <motion.li
              key={`${i}-${text}`}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, ease: EASE, delay: 0.25 + index * 0.07 + i * 0.05 }}
              className="flex gap-2 text-[13px] leading-snug text-slate-200"
            >
              {kind === 'nextSteps' ? (
                <span className="mt-[1px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[10px] font-bold" style={{ background: `${m.color}26`, color: m.color }}>{i + 1}</span>
              ) : (
                <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.color }} />
              )}
              <span className="min-w-0">{text}</span>
            </motion.li>
          ))}
        </ul>
      </div>
    </Reveal>
  );
};

const Footer: React.FC<{ b: BusinessOverview; index: number }> = ({ b, index }) => {
  const where = displayLocation(b.source, b.location);
  const ago = timeAgo(b.updatedAt);
  if (!where && !ago) return null;
  const Icon = b.source === 'website' ? Globe : (b.source as string) === 'file' ? FileIcon : Folder;
  const href = b.source === 'website' && /^https?:\/\//i.test(b.location) ? b.location : undefined;
  return (
    <Reveal index={index} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 pt-3 text-[11px] text-slate-500">
      {where && (
        <span className="flex min-w-0 max-w-full items-center gap-1.5" title={b.location}>
          <Icon size={12} className="shrink-0" />
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="truncate font-mono hover:text-slate-300 hover:underline">{where}</a>
          ) : (
            <span className="truncate font-mono">{where}</span>
          )}
        </span>
      )}
      {ago && <span className="flex items-center gap-1.5"><Clock size={12} /> Analysed {ago}</span>}
    </Reveal>
  );
};

const Detail: React.FC<{ b: BusinessOverview }> = ({ b }) => {
  const tone = toneOf(b);
  const kpis = (b.kpis ?? []).filter((k) => k && k.label && k.value !== undefined && k.value !== '');
  const lists = (['highlights', 'risks', 'nextSteps'] as const).filter((k) => (b[k]?.length ?? 0) > 0);
  const chart = (b.activity?.points?.length ?? 0) >= 2 ? b.activity! : null;
  const kpiCols = kpis.length >= 4 ? 'grid-cols-2 lg:grid-cols-4' : kpis.length === 3 ? 'grid-cols-3' : 'grid-cols-2';
  const listCols = lists.length === 3 ? 'md:grid-cols-3' : lists.length === 2 ? 'md:grid-cols-2' : '';
  return (
    <div className="flex flex-col gap-5">
      <Reveal index={0} className="flex items-start gap-3 sm:gap-4">
        <Logo b={b} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[20px] font-semibold leading-tight">{b.name}</h3>
            <KindPill b={b} />
          </div>
          {b.tagline && <p className="mt-1 line-clamp-3 text-[13px] text-slate-400 sm:line-clamp-2">{b.tagline}</p>}
          {b.stage && <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">{b.stage}</p>}
        </div>
        {/* A smaller ring on phones leaves the name and tagline room. */}
        <div className="hidden sm:block"><Health b={b} /></div>
        <div className="sm:hidden"><Health b={b} size={70} /></div>
      </Reveal>

      {b.summary && (
        <Reveal index={1}>
          <p className="text-[14px] leading-relaxed text-slate-300">{b.summary}</p>
        </Reveal>
      )}

      {kpis.length > 0 && (
        <Reveal index={2} className={`grid gap-2 ${kpiCols}`}>
          {kpis.map((k, i) => <KpiTile key={`${i}-${k.label}`} kpi={k} />)}
        </Reveal>
      )}

      {chart && (
        <Reveal index={3}>
          <Activity activity={chart} color={tone === palette.muted ? BUSINESS_ACCENT : tone} />
        </Reveal>
      )}

      {lists.length > 0 && (
        <div className={`grid gap-3 ${listCols}`}>
          {lists.map((k, i) => <ListPanel key={k} kind={k} items={b[k]!} index={4 + i} />)}
        </div>
      )}

      <Footer b={b} index={7} />
    </div>
  );
};

const CHANGE_TONE = { success: palette.success, danger: palette.danger, muted: palette.muted };

/** "+$174.30 (12.6%)" in green, "−$20.00 (4.1%)" in red, with an arrow; nothing without a change. */
const ChangeBadge: React.FC<{ t: BusinessTotals; big?: boolean }> = ({ t, big }) => {
  if (t.change === undefined) return null;
  const { sign, tone } = changeTone(t.change);
  const color = CHANGE_TONE[tone];
  const Icon = tone === 'success' ? TrendingUp : tone === 'danger' ? TrendingDown : Minus;
  const sym = currencySymbol(t.currency);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-bold tabular-nums ${big ? 'px-2.5 py-1 text-[13px]' : 'px-2 py-0.5 text-[11px]'}`} style={{ color, background: `${color}1f`, borderColor: `${color}55` }}>
      <Icon size={big ? 14 : 12} />
      {sign}{sym}{fmt(Math.abs(t.change), 2, 2)}
      {t.changePercent !== undefined && <span className="font-semibold opacity-80">({Math.abs(t.changePercent)}%)</span>}
    </span>
  );
};

/** The portfolio's overall revenue and its gain / loss vs the previous period (the "All" view). */
const TotalsBanner: React.FC<{ t: BusinessTotals }> = ({ t }) => {
  const { tone } = changeTone(t.change);
  const glow = CHANGE_TONE[tone];
  return (
    <Reveal index={1}>
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/35 px-4 py-3.5" style={{ boxShadow: tone === 'muted' ? undefined : `inset 0 0 40px ${glow}14` }}>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">Overall revenue</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <CountUp value={t.revenue} decimals={2} minDecimals={2} prefix={currencySymbol(t.currency)} className="text-[30px] font-bold leading-none" />
              <span className="text-[13px] text-slate-400">/ {periodShort(t.period)}</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <ChangeBadge t={t} big />
            <span className="text-[11px] text-slate-500">
              {t.change !== undefined ? `vs last ${t.period || 'month'}` : ''}{t.change !== undefined ? ' · ' : ''}{t.businesses} {t.businesses === 1 ? 'business' : 'businesses'} with revenue
            </span>
          </div>
        </div>
      </div>
    </Reveal>
  );
};

/** One line over a business's detail: where the whole portfolio stands. */
const TotalsStrip: React.FC<{ t: BusinessTotals }> = ({ t }) => (
  <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-slate-400">
    <span className="font-semibold uppercase tracking-[0.12em] text-[10px]">Portfolio</span>
    <span className="font-semibold tabular-nums text-slate-200">{currencySymbol(t.currency)}{fmt(t.revenue, 2, 2)}<span className="font-normal text-slate-500"> / {periodShort(t.period)}</span></span>
    <ChangeBadge t={t} />
  </div>
);

/** Every business at a glance: its ring, status and headline KPI; click one for its detail. */
const Portfolio: React.FC<{ list: BusinessOverview[]; totals?: BusinessTotals; onOpen: (id: string) => void }> = ({ list, totals, onOpen }) => (
  <div className="flex flex-col gap-4">
    <Reveal index={0} className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[20px] font-semibold leading-tight">Your portfolio</div>
        <div className="mt-0.5 text-[12px] text-slate-400">{portfolioLine(list)}</div>
      </div>
    </Reveal>
    {totals && <TotalsBanner t={totals} />}
    <div className={`grid gap-2 ${list.length > 1 ? 'sm:grid-cols-2' : ''} ${list.length > 4 ? 'lg:grid-cols-3' : ''}`}>
      {list.map((b, i) => {
        const tone = toneOf(b);
        const kpi = b.kpis?.find((k) => k?.label && k.value);
        return (
          <motion.button
            key={b.id}
            type="button"
            onClick={() => onOpen(b.id)}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 180, delay: 0.1 + Math.min(i, 10) * 0.04 }}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            className="group relative flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-white/10 bg-black/30 p-3 text-left transition-colors hover:border-white/20 hover:bg-black/45"
          >
            <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px]" style={{ background: tone, opacity: tone === palette.muted ? 0 : 0.85 }} />
            <Logo b={b} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold">{b.name}</div>
              {kpi ? (
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px]">
                  <span className="truncate text-slate-400">{kpi.label}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-slate-100">{kpi.value}</span>
                  <TrendMark trend={kpi.trend} size={12} />
                </div>
              ) : (b.tagline || b.stage) ? (
                <div className="mt-0.5 truncate text-[12px] text-slate-400">{b.tagline || b.stage}</div>
              ) : null}
              {b.status && <div className="mt-0.5 text-[11px] font-semibold" style={{ color: tone }}>{statusLabel(b.status)}</div>}
            </div>
            {hasHealth(b) && <RingGauge percent={Math.round(b.health!)} color={tone} size={48} stroke={5} />}
            <ChevronRight size={16} className="shrink-0 text-slate-500 transition-colors group-hover:text-slate-200" />
          </motion.button>
        );
      })}
    </div>
  </div>
);

/** Switcher: "All" + one chip per business; scrolls sideways when they don't fit. */
const Switcher: React.FC<{ list: BusinessOverview[]; value: string; onChange: (v: string) => void }> = ({ list, value, onChange }) => {
  const items = [{ id: 'all', name: 'All', tone: undefined as string | undefined }, ...list.map((b) => ({ id: b.id, name: b.name, tone: toneOf(b) }))];
  // Fade the edge(s) that have more chips past them.
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = () => {
    const el = ref.current;
    if (el) setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [list.length]);
  // Keep the selected chip in view.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [value]);
  const mask = edges.left || edges.right
    ? `linear-gradient(90deg, ${edges.left ? 'transparent, #000 40px' : '#000'}, ${edges.right ? '#000 calc(100% - 40px), transparent' : '#000'})`
    : undefined;
  return (
    <div
      ref={ref}
      onScroll={measure}
      className="-mx-1 overflow-x-auto px-1 pb-1 scrollbar-thin"
      role="tablist"
      aria-label="Businesses"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      <div className="flex w-max min-w-full gap-1 rounded-full border border-white/10 bg-black/40 p-0.5">
        {items.map((it) => {
          const on = it.id === value;
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(it.id)}
              className={`relative z-10 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${list.length <= 3 ? 'flex-1 justify-center' : ''} ${on ? 'text-slate-900' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {on && <motion.span layoutId="business-switch" className="absolute inset-0 -z-10 rounded-full" style={{ background: BUSINESS_ACCENT }} transition={{ type: 'spring', damping: 22, stiffness: 300 }} />}
              {it.id === 'all' ? <LayoutGrid size={12} /> : <span className="h-1.5 w-1.5 rounded-full" style={{ background: on ? '#0B1220' : it.tone }} />}
              <span className="max-w-[160px] truncate">{it.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** Settings → Businesses, from the card's empty state. */
const openBusinessSettings = () => {
  const s = useStore.getState();
  s.dismissOutcome();
  s.setSettingsOpen(true);
  setTimeout(() => document.getElementById('settings-businesses')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 450);
};

const Empty: React.FC = () => (
  <CardShell accent={BUSINESS_ACCENT}>
    <Reveal index={0} className="flex flex-col items-center gap-3 px-2 py-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl border" style={{ color: BUSINESS_ACCENT, background: `${BUSINESS_ACCENT}22`, borderColor: `${BUSINESS_ACCENT}55`, boxShadow: `0 0 32px ${BUSINESS_ACCENT}40` }}>
        <Briefcase size={26} />
      </div>
      <div className="text-[20px] font-semibold">Add your first business</div>
      <p className="max-w-md text-[14px] leading-relaxed text-slate-400">
        Point Jarvis at a project folder, a file or your website. It keeps an overview of how things stand, ready whenever you ask “How’s my business?”.
      </p>
      <motion.button
        type="button"
        whileTap={{ scale: 0.96 }}
        onClick={openBusinessSettings}
        className="mt-1 flex h-10 items-center gap-2 rounded-full px-5 text-[13px] font-semibold"
        style={{ background: BUSINESS_ACCENT, color: '#0B1220' }}
      >
        <Settings size={15} /> Add one in Settings
      </motion.button>
    </Reveal>
  </CardShell>
);

export const BusinessDashboardCard: React.FC<{ data: BusinessDashboardData }> = ({ data }) => {
  const list = (data.businesses ?? []).filter((b) => b && b.id && b.name);
  const [picked, setPicked] = useState<string>(() => initialView({ businesses: list, focusId: data.focusId }));
  if (data.empty || list.length === 0) return <Empty />;
  const view = picked === 'all' && list.length > 1 ? 'all' : list.some((b) => b.id === picked) ? picked : list[0].id;
  const current = list.find((b) => b.id === view);

  // One accent for the card (it doesn't flash colours while switching); each business's status
  // colours its ring, chart and portfolio row.
  return (
    <CardShell accent={BUSINESS_ACCENT}>
      {list.length > 1 && (
        <div className="flex items-center gap-2">
          {view !== 'all' && list.length > 3 && (
            <button type="button" onClick={() => setPicked('all')} aria-label="All businesses" className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-black/40 text-slate-300 hover:text-white">
              <ChevronLeft size={16} />
            </button>
          )}
          <div className="min-w-0 flex-1"><Switcher list={list} value={view} onChange={setPicked} /></div>
        </div>
      )}
      {view !== 'all' && list.length > 1 && data.totals && <TotalsStrip t={data.totals} />}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2, ease: EASE }}>
          {view === 'all' ? <Portfolio list={list} totals={data.totals} onOpen={setPicked} /> : current && <Detail b={current} />}
        </motion.div>
      </AnimatePresence>
    </CardShell>
  );
};
