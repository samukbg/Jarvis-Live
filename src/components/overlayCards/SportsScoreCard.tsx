import React from 'react';
import { motion } from 'framer-motion';
import { BarChart3 } from 'lucide-react';
import type { SportsScoreData } from './types';
import type { CardLive } from './enrichment';
import { CardShell, CountUp, EASE, Reveal, SectionLabel, palette } from './kit';
import { LiveDot } from './motion';

const numeric = (v: string | number) => (typeof v === 'number' ? v : parseFloat(String(v).replace('%', '')));
const A_COLOR = palette.success;
const B_COLOR = palette.indigo;

const Team: React.FC<{ name: string; logo?: string; scorers?: string[]; winner: boolean; align: 'left' | 'right'; color: string }> = ({ name, logo, scorers, winner, align, color }) => (
  <div className={`flex min-w-0 flex-1 flex-col gap-1.5 ${align === 'left' ? 'items-start text-left' : 'items-end text-right'}`}>
    <div>
      <motion.div
        className="flex h-16 w-16 items-center justify-center rounded-full border-[1.5px] bg-black/45"
        style={{ borderColor: winner ? color : 'rgba(148,210,255,0.10)', boxShadow: winner ? `0 0 22px ${color}66` : undefined }}
        animate={winner ? { scale: [1, 1.06, 1] } : undefined}
        transition={{ duration: 2.8, repeat: Infinity, delay: 0.9 }}
      >
        {logo ? <img src={logo} alt="" className="h-11 w-11 object-contain" /> : <span className="text-[18px] font-bold">{name.slice(0, 3).toUpperCase()}</span>}
      </motion.div>
    </div>
    <span className="line-clamp-2 text-[16px] font-semibold">{name}</span>
    {scorers?.map((s, i) => <span key={i} className="max-w-full truncate text-[11px] text-slate-400">⚽ {s}</span>)}
  </div>
);

export const SportsScoreCard: React.FC<{ data: SportsScoreData; live?: CardLive }> = ({ data, live }) => {
  const { teamA, teamB } = data;
  const isLive = data.live || live?.live;
  const accent = isLive ? palette.danger : palette.success;
  const kickoff = data.startTime && /\d{4}-\d{2}-\d{2}T/.test(data.startTime)
    ? new Date(data.startTime).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : undefined;
  return (
    <CardShell accent={accent}>
      {(data.league || data.status) && (
        <Reveal index={0} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {data.league && <div className="text-[13px] text-slate-300">{data.league}</div>}
            {(data.venue || kickoff) && <div className="truncate text-[11px] text-slate-500">{[data.venue, kickoff].filter(Boolean).join(' · ')}</div>}
          </div>
          {data.status && (
            <span className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold" style={{ color: isLive ? palette.danger : '#CBD5E1', background: `${isLive ? palette.danger : palette.muted}22` }}>
              {isLive && <LiveDot size={6} />}{isLive ? `LIVE · ${data.status}` : data.status}
            </span>
          )}
        </Reveal>
      )}

      <div>
        <Reveal index={1} className="flex items-start gap-2">
          <Team name={teamA.name} logo={teamA.logo} scorers={teamA.scorers} winner={teamA.score > teamB.score} align="left" color={A_COLOR} />
          <motion.div initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', damping: 12, delay: 0.25 }} className="flex items-center gap-2 pt-3">
            <CountUp value={teamA.score} duration={0.7} className="text-[42px] font-bold" />
            <span className="text-xl text-slate-500">–</span>
            <CountUp value={teamB.score} duration={0.7} className="text-[42px] font-bold" />
          </motion.div>
          <Team name={teamB.name} logo={teamB.logo} scorers={teamB.scorers} winner={teamB.score > teamA.score} align="right" color={B_COLOR} />
        </Reveal>
      </div>

      {data.stats && data.stats.length > 0 && (
        <Reveal index={2}>
          <SectionLabel icon={<BarChart3 size={13} style={{ color: accent }} />}>Match stats</SectionLabel>
          <div className="flex flex-col gap-3">
            {data.stats.map((s, i) => {
              const a = numeric(s.valueA);
              const b = numeric(s.valueB);
              const share = Number.isFinite(a) && Number.isFinite(b) && a + b > 0 ? (a / (a + b)) * 100 : undefined;
              return (
                <Reveal key={`${s.label}-${i}`} index={3 + i} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[15px] font-semibold tabular-nums" style={{ color: share !== undefined && share > 50 ? A_COLOR : undefined }}>{String(s.valueA)}</span>
                    <span className="text-[11px] text-slate-500">{s.label}</span>
                    <span className="text-[15px] font-semibold tabular-nums" style={{ color: share !== undefined && share < 50 ? B_COLOR : undefined }}>{String(s.valueB)}</span>
                  </div>
                  {share !== undefined && (
                    <div className="flex gap-1">
                      <div className="flex h-1.5 flex-1 justify-end overflow-hidden rounded-full bg-sky-200/[0.07]">
                        <motion.div className="h-full rounded-full" style={{ background: share >= 50 ? A_COLOR : `${A_COLOR}66` }} initial={{ width: 0 }} animate={{ width: `${share}%` }} transition={{ duration: 0.8, ease: EASE, delay: 0.3 + i * 0.08 }} />
                      </div>
                      <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-sky-200/[0.07]">
                        <motion.div className="h-full rounded-full" style={{ background: share <= 50 ? B_COLOR : `${B_COLOR}66` }} initial={{ width: 0 }} animate={{ width: `${100 - share}%` }} transition={{ duration: 0.8, ease: EASE, delay: 0.3 + i * 0.08 }} />
                      </div>
                    </div>
                  )}
                </Reveal>
              );
            })}
          </div>
        </Reveal>
      )}
    </CardShell>
  );
};
