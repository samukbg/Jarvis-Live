import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BarChart3, LineChart, PieChart } from 'lucide-react';
import type { ChartData } from './types';
import { CardShell, EASE, GrowBar, Reveal, fmt, palette } from './kit';
import { Donut, ScrubChart, Segmented } from './motion';

const SERIES = [palette.accent, palette.violet, palette.success, palette.warning, '#F472B6', palette.indigo];
const color = (i: number, c?: string) => c || SERIES[i % SERIES.length];
type View3 = 'bar' | 'line' | 'donut';

export const DataChartCard: React.FC<{ data: ChartData }> = ({ data }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const all = data.datasets.flatMap((d) => d.data);
  const max = Math.max(...all, 0);
  const nonNegative = all.every((v) => v >= 0);
  // Views the data supports: shares only for one non-negative series, lines need ≥ 2 points.
  const views: View3[] = ['bar'];
  if (data.labels.length >= 2) views.push('line');
  if (data.datasets.length === 1 && nonNegative && data.labels.length >= 2) views.push('donut');
  const initial: View3 = data.chartType === 'pie' || data.chartType === 'donut' ? 'donut' : data.chartType === 'line' || data.chartType === 'area' ? 'line' : 'bar';
  const [view, setView] = useState<View3>(views.includes(initial) ? initial : 'bar');
  const total = data.datasets[0]?.data.reduce((a, b) => a + b, 0) ?? 0;

  return (
    <CardShell accent={palette.accent}>
      <Reveal index={0}>
        <div className="text-[20px] font-semibold">{data.title}</div>
        <div className="min-h-[18px] text-[12px] text-slate-500">
          {selected !== null ? `${data.labels[selected]}: ${data.datasets.map((d) => `${d.label} ${fmt(d.data[selected])}`).join(' · ')}` : `${data.labels.length} data points`}
        </div>
      </Reveal>

      {views.length > 1 && (
        <Reveal index={1}>
          <Segmented
            items={views.map((v) => ({ key: v, label: v === 'bar' ? 'Bars' : v === 'line' ? 'Line' : 'Share', icon: v === 'bar' ? <BarChart3 size={13} /> : v === 'line' ? <LineChart size={13} /> : <PieChart size={13} /> }))}
            value={view}
            onChange={(v) => { setView(v); setSelected(null); }}
          />
        </Reveal>
      )}

      {data.datasets.length > 1 && (
        <Reveal index={2} className="flex flex-wrap gap-3">
          {data.datasets.map((d, i) => (
            <span key={d.label} className="flex items-center gap-1.5 text-[12px] text-slate-300">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color(i, d.color) }} />{d.label}
            </span>
          ))}
        </Reveal>
      )}

      <AnimatePresence mode="wait">
        <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
          <div>
            {view === 'donut' ? (
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                <Donut values={data.datasets[0].data} colors={data.labels.map((_, i) => color(i))} size={160} onSelect={(i) => setSelected(selected === i ? null : i)}>
                  <span className="text-[11px] text-slate-500">{selected !== null ? data.labels[selected] : 'Total'}</span>
                  <span className="text-[20px] font-semibold tabular-nums">{fmt(selected !== null ? data.datasets[0].data[selected] : total)}</span>
                </Donut>
                <div className="flex w-full flex-col gap-1">
                  {data.labels.map((label, i) => {
                    const v = data.datasets[0].data[i];
                    const pct = total > 0 ? (v / total) * 100 : 0;
                    return (
                      <button key={`${label}-${i}`} onClick={() => setSelected(selected === i ? null : i)} className={`flex flex-col gap-1.5 rounded-lg p-2 text-left transition-colors ${selected === i ? 'bg-cyan-400/10' : 'hover:bg-white/5'}`}>
                        <span className="flex items-center gap-2 text-[14px]">
                          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color(i) }} />
                          <span className="flex-1 truncate">{label}</span>
                          <span className="text-[13px] tabular-nums">{fmt(pct, 1)}%</span>
                        </span>
                        <GrowBar percent={pct} color={color(i)} height={4} delay={0.15 + i * 0.07} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : view === 'line' ? (
              <div>
                <div className="relative" style={{ height: 190 }}>
                  {data.datasets.map((d, i) => (
                    <div key={d.label} className={i === 0 ? 'relative' : 'pointer-events-none absolute inset-0'}>
                      <ScrubChart values={d.data} color={color(i, d.color)} height={190} onScrub={i === 0 ? setSelected : undefined} interactive={i === 0} />
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                  <span>{data.labels[0]}</span><span>Hover to read values</span><span>{data.labels[data.labels.length - 1]}</span>
                </div>
              </div>
            ) : (
              <div className="flex h-[230px] items-end gap-2">
                {data.labels.map((label, i) => (
                  <button key={`${label}-${i}`} onClick={() => setSelected(selected === i ? null : i)} onMouseEnter={() => setSelected(i)} onMouseLeave={() => setSelected(null)} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1">
                    <div className="flex flex-col items-center text-[11px] tabular-nums text-slate-400">
                      {data.datasets.map((d) => <span key={d.label}>{fmt(d.data[i])}</span>)}
                    </div>
                    <div className="flex w-full flex-1 items-end justify-center gap-[3px]">
                      {data.datasets.map((d, j) => (
                        <motion.div
                          key={d.label}
                          className="min-h-[2px] max-w-[34px] flex-1 rounded-t-md"
                          style={{ background: color(j, d.color) }}
                          initial={{ height: 0 }}
                          animate={{ height: `${max > 0 ? (Math.max(0, d.data[i]) / max) * 100 : 0}%`, opacity: selected !== null && selected !== i ? 0.35 : 1 }}
                          transition={{ duration: 0.75, ease: EASE, delay: 0.15 + i * 0.07 }}
                        />
                      ))}
                    </div>
                    <span className="w-full truncate text-center text-[11px] text-slate-400">{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </CardShell>
  );
};
