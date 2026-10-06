import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { TrendingUp, TrendingDown, ChartLine, Info } from 'lucide-react';
import type { FinanceData, FinanceRange } from './types';
import type { CardLive } from './enrichment';
import { CardShell, CountUp, Pill, Reveal, SectionLabel, Stat, StatGrid, fmt, fmtPrice, palette } from './kit';
import { LiveDot, ScrubChart, Segmented } from './motion';

const RANGE_LABEL: Record<FinanceRange, string> = { '1D': 'Today', '1W': 'Past week', '1M': 'Past month', '1Y': 'Past year', ALL: 'All time' };

const timeLabel = (t: number, range: FinanceRange) =>
  new Date(t).toLocaleString('en-US', range === '1D' ? { hour: '2-digit', minute: '2-digit' } : range === 'ALL' ? { year: 'numeric' } : range === '1Y' ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });

export const FinanceCard: React.FC<{ data: FinanceData; live?: CardLive }> = ({ data, live }) => {
  const ranges = (Object.keys(RANGE_LABEL) as FinanceRange[]).filter((r) => (data.histories?.[r]?.length ?? 0) > 1);
  const [range, setRange] = useState<FinanceRange | null>(null);
  // A session that just opened has only a few 1D points; start on the week then.
  const preferred = ranges.find((r) => (data.histories?.[r]?.length ?? 0) >= 12) ?? ranges[0];
  const active = range && ranges.includes(range) ? range : preferred;
  const [scrub, setScrub] = useState<number | null>(null);

  const series = active ? data.histories![active]! : null;
  const legacy = !series && (data.history?.length ?? 0) >= 2 ? data.history! : null;
  const values = series ? series.map((p) => p.value) : legacy ? legacy.map((h) => h.value) : [];

  const first = series?.[0]?.value;
  const rangeChange = series && active !== '1D' && first ? data.price - first : undefined;
  const change = rangeChange ?? data.change;
  const pct = rangeChange !== undefined && first ? (rangeChange / first) * 100 : data.changePercent;
  const up = pct !== undefined ? pct >= 0 : change !== undefined ? change >= 0 : undefined;
  const accent = up === undefined ? palette.accent : up ? palette.success : palette.danger;
  const cur = data.currency && data.currency !== 'USD' ? ({ EUR: '€', GBP: '£' } as Record<string, string>)[data.currency] ?? `${data.currency} ` : '$';
  const scrubbedValue = scrub !== null ? values[scrub] : undefined;
  const scrubbedLabel = scrub !== null ? (series && active ? timeLabel(series[scrub].t, active) : legacy?.[scrub].time) : undefined;

  const stats: Array<[string, string]> = [];
  if (data.previousClose !== undefined) stats.push(['Previous close', `${cur}${fmtPrice(data.previousClose)}`]);
  if (data.high24h !== undefined) stats.push(['Day high', `${cur}${fmtPrice(data.high24h)}`]);
  if (data.low24h !== undefined) stats.push(['Day low', `${cur}${fmtPrice(data.low24h)}`]);
  if (data.week52High !== undefined) stats.push(['52-week high', `${cur}${fmtPrice(data.week52High)}`]);
  if (data.week52Low !== undefined) stats.push(['52-week low', `${cur}${fmtPrice(data.week52Low)}`]);
  if (data.marketCap) stats.push(['Market cap', data.marketCapRank ? `${data.marketCap} · #${data.marketCapRank}` : data.marketCap]);
  if (data.volume24h) stats.push(['Volume', data.volume24h]);
  if (data.peRatio !== undefined) stats.push(['P/E ratio', fmt(data.peRatio)]);
  if (data.dividendYield) stats.push(['Dividend yield', data.dividendYield]);
  if (data.targetPrice !== undefined) stats.push(['1-year target', `${cur}${fmtPrice(data.targetPrice)}`]);
  if (data.sector) stats.push(['Sector', data.industry ? `${data.sector} · ${data.industry}` : data.sector]);
  const has52 = data.week52High !== undefined && data.week52Low !== undefined && data.week52High > data.week52Low;
  const pos52 = has52 ? Math.max(0, Math.min(100, ((data.price - data.week52Low!) / (data.week52High! - data.week52Low!)) * 100)) : 0;

  return (
    <CardShell accent={accent}>
      <div>
        <Reveal index={0} className="flex items-center gap-3">
          <div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border px-1 text-[12px] font-extrabold" style={{ color: accent, background: `${accent}22`, borderColor: `${accent}55`, boxShadow: `0 0 24px ${accent}33` }}>
              {data.symbol.replace(/-USD$/, '')}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[17px] font-semibold">{data.name ?? data.symbol}</div>
            <div className="truncate text-[13px] text-slate-400">{[data.symbol, data.exchange].filter(Boolean).join(' · ')}</div>
          </div>
          {live?.live && (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
              <LiveDot color={palette.success} size={6} /> Live
            </span>
          )}
        </Reveal>

        <Reveal index={1} className="mt-4 flex min-h-[78px] flex-col gap-2">
          {scrubbedValue !== undefined ? (
            <span className="text-[34px] font-bold tabular-nums tracking-tight">{cur}{fmtPrice(scrubbedValue)}</span>
          ) : (
            <CountUp value={data.price} decimals={2} minDecimals={2} prefix={cur} className="text-[34px] font-bold tracking-tight" />
          )}
          {scrubbedValue !== undefined ? (
            <span className="text-[13px] text-slate-400">{scrubbedLabel}</span>
          ) : (change !== undefined || pct !== undefined) && (
            <AnimatePresence mode="wait">
              <motion.div key={active ?? 'd'} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
                <Pill
                  color={accent}
                  icon={up ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                  label={[
                    change !== undefined ? `${change >= 0 ? '+' : '−'}${cur}${fmtPrice(Math.abs(change))}` : null,
                    pct !== undefined ? `${pct >= 0 ? '+' : '−'}${fmt(Math.abs(pct))}%` : null,
                  ].filter(Boolean).join('  ')}
                />
                <span className="text-[11px] text-slate-500">{active ? RANGE_LABEL[active] : 'Today'}</span>
              </motion.div>
            </AnimatePresence>
          )}
        </Reveal>
      </div>

      {values.length >= 2 && (
        <Reveal index={2} className="flex flex-col gap-3">
          {ranges.length > 1 ? (
            <Segmented accent={accent} items={ranges.map((r) => ({ key: r, label: r }))} value={active!} onChange={(r) => { setRange(r); setScrub(null); }} />
          ) : (
            <SectionLabel icon={<ChartLine size={13} style={{ color: accent }} />}>Price history</SectionLabel>
          )}
          <ScrubChart key={active ?? 'legacy'} values={values} color={accent} height={180} onScrub={setScrub} baseline={active === '1D' ? data.previousClose : undefined} />
          <div className="flex justify-between text-[11px] text-slate-500">
            <span>{series && active ? timeLabel(series[0].t, active) : legacy?.[0].time}</span>
            <span>Hover or drag to explore</span>
            <span>{series && active ? timeLabel(series[series.length - 1].t, active) : legacy?.[legacy.length - 1].time}</span>
          </div>
        </Reveal>
      )}

      {has52 && (
        <Reveal index={3} className="flex flex-col gap-2">
          <div className="flex justify-between text-[11px]">
            <span className="text-slate-500">52-week range</span>
            <span className="tabular-nums text-slate-300">{cur}{fmtPrice(data.week52Low!)} – {cur}{fmtPrice(data.week52High!)}</span>
          </div>
          <div className="relative flex h-1.5 items-center rounded-full bg-white/10">
            <motion.div className="absolute left-0 h-1.5 rounded-full" style={{ background: `${accent}55` }} initial={{ width: 0 }} animate={{ width: `${pos52}%` }} transition={{ duration: 0.8, delay: 0.3 }} />
            <motion.span className="absolute h-3 w-3 -translate-x-1/2 rounded-full border-2 border-[#02060C]" style={{ background: accent }} initial={{ left: '0%' }} animate={{ left: `${pos52}%` }} transition={{ type: 'spring', damping: 14, delay: 0.3 }} />
          </div>
        </Reveal>
      )}

      {stats.length > 0 && (
        <Reveal index={4}>
          <StatGrid>
            {stats.map(([label, value]) => <Stat key={label} label={label}>{value}</Stat>)}
          </StatGrid>
        </Reveal>
      )}

      {values.length < 2 && stats.length === 0 && pct === undefined && (
        <div className="flex items-center gap-1.5 text-[12px] text-slate-500">
          <Info size={13} /> Only the current price was reported.
        </div>
      )}
    </CardShell>
  );
};
