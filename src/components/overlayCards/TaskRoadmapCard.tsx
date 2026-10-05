import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CircleCheck, Circle, Flag, Loader } from 'lucide-react';
import type { TaskRoadmapData } from './types';
import { CardShell, CountUp, GrowBar, Pill, Reveal, SectionLabel, palette } from './kit';


const PRIORITY: Record<string, string> = { URGENT: palette.danger, HIGH: palette.warning, MEDIUM: palette.accent, LOW: palette.muted };

const MilestoneDot: React.FC<{ status: string }> = ({ status }) => {
  const color = status === 'COMPLETED' ? palette.success : status === 'IN PROGRESS' ? palette.warning : palette.muted;
  const Icon = status === 'COMPLETED' ? CircleCheck : status === 'IN PROGRESS' ? Loader : Circle;
  return (
    <motion.span
      className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full border-2 bg-[#02060C]"
      style={{ borderColor: color, boxShadow: status === 'IN PROGRESS' ? `0 0 16px ${color}66` : undefined }}
      animate={status === 'IN PROGRESS' ? { scale: [1, 1.15, 1] } : undefined}
      transition={{ duration: 1.4, repeat: Infinity, delay: 0.6 }}
    >
      <Icon size={18} style={{ color }} />
    </motion.span>
  );
};

export const TaskRoadmapCard: React.FC<{ data: TaskRoadmapData }> = ({ data }) => {
  // Local checklist: ticking a task here updates the progress (it is not sent anywhere).
  const [done, setDone] = useState<Record<string, boolean>>(() => Object.fromEntries(data.tasks.map((t) => [t.id, t.completed])));
  const doneCount = data.tasks.filter((t) => done[t.id]).length;
  const pct = data.tasks.length ? Math.round((doneCount / data.tasks.length) * 100) : data.progressPercent;
  const milestones = data.milestones ?? [];
  const reached = milestones.filter((m) => m.status === 'COMPLETED').length;
  const partial = milestones.some((m) => m.status === 'IN PROGRESS') ? 0.5 : 0;
  const line = milestones.length > 1 ? Math.max(0, ((reached - 1 + partial) / (milestones.length - 1)) * 100) : 0;
  const complete = pct === 100;

  return (
    <CardShell accent={palette.violet}>
      <div>
        <Reveal index={0} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[20px] font-semibold">{data.projectTitle || 'Checklist'}</div>
            {data.description && <div className="text-[12px] text-slate-400">{data.description}</div>}
            <div className="text-[12px] text-slate-500">{doneCount} of {data.tasks.length} done</div>
          </div>
          <div>
            <CountUp value={pct} suffix="%" className="text-[28px] font-bold" />
          </div>
        </Reveal>
        <Reveal index={1} className="mt-3">
          <GrowBar percent={pct} color={complete ? palette.success : palette.violet} height={10} />
        </Reveal>
      </div>

      {milestones.length > 0 && (
        <Reveal index={2}>
          <SectionLabel icon={<Flag size={13} className="text-violet-400" />}>Milestones</SectionLabel>
          <div className="overflow-x-auto pb-1">
            <div className="relative flex w-max gap-2">
              <div className="absolute left-[50px] right-[50px] top-[17px] h-[3px] rounded-full bg-sky-200/10">
                <motion.div className="h-full rounded-full bg-emerald-400" initial={{ width: 0 }} animate={{ width: `${line}%` }} transition={{ duration: 1, delay: 0.4 }} />
              </div>
              {milestones.map((m, i) => (
                <Reveal key={`${m.title}-${i}`} index={3 + i} className="flex w-[100px] shrink-0 flex-col items-center gap-1.5 text-center">
                  <MilestoneDot status={m.status} />
                  <span className="line-clamp-2 text-[13px] font-medium">{m.title}</span>
                  {m.date && <span className="text-[11px] text-slate-500">{m.date}</span>}
                </Reveal>
              ))}
            </div>
          </div>
        </Reveal>
      )}

      <div className="flex flex-col gap-2">
        {data.tasks.map((t, i) => {
          const on = !!done[t.id];
          return (
            <Reveal key={t.id} index={4 + i}>
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={() => setDone((d) => ({ ...d, [t.id]: !d[t.id] }))}
                className={`flex w-full items-center gap-3 rounded-xl border border-sky-200/10 bg-black/35 p-3 text-left transition-colors hover:bg-black/50 ${on ? 'opacity-75' : ''}`}
                role="checkbox"
                aria-checked={on}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span key={on ? 'on' : 'off'} initial={{ scale: 0.4 }} animate={{ scale: 1 }} exit={{ scale: 0.4 }} transition={{ type: 'spring', damping: 12 }}>
                    {on ? <CircleCheck size={20} className="text-emerald-400" /> : <Circle size={20} className="text-slate-500" />}
                  </motion.span>
                </AnimatePresence>
                <div className="min-w-0 flex-1">
                  <div className={`text-[14px] ${on ? 'text-slate-500 line-through' : ''}`}>{t.title}</div>
                  {t.assignee && <div className="text-[11px] text-slate-500">{t.assignee}</div>}
                </div>
                {t.priority && <Pill label={t.priority.charAt(0) + t.priority.slice(1).toLowerCase()} color={PRIORITY[t.priority]} />}
              </motion.button>
            </Reveal>
          );
        })}
      </div>
    </CardShell>
  );
};
