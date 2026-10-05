import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ShoppingBasket, ListOrdered, Timer, Flame, Users, Signal, CircleCheck, Circle, Globe, UtensilsCrossed, PlayCircle, ExternalLink, Check, PartyPopper, CookingPot, Pause, Play, RotateCcw, PieChart } from 'lucide-react';
import type { RecipeData } from './types';
import { CardShell, GrowBar, Pill, Reveal, RingGauge, SectionLabel, Stat, StatGrid, palette } from './kit';
import { macroCalories, parseDuration } from './enrichment';


const ORANGE = '#FB923C';
const MACRO_COLORS: Record<string, string> = { protein: '#F472B6', carbs: '#FBBF24', fat: '#38BDF8' };
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Click to start / pause the countdown; double-click to reset. */
const KitchenTimer: React.FC<{ label: string; icon: React.ReactNode; duration: string }> = ({ label, icon, duration }) => {
  const total = parseDuration(duration);
  const [left, setLeft] = useState(total ?? 0);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setLeft((l) => {
      if (l <= 1) { setRunning(false); navigator.vibrate?.([400, 200, 400]); return 0; }
      return l - 1;
    }), 1000);
    return () => clearInterval(id);
  }, [running]);
  const pct = total ? ((total - left) / total) * 100 : 0;
  return (
    <button
      onClick={() => total && (left === 0 ? (setLeft(total), setRunning(true)) : setRunning((r) => !r))}
      onDoubleClick={() => { setRunning(false); setLeft(total ?? 0); }}
      className={`flex flex-1 flex-col gap-1 rounded-xl border bg-black/40 p-3 text-left transition-colors ${running ? 'border-orange-400' : 'border-white/10 hover:border-white/25'}`}
      title={total ? 'Click to start / pause · double-click to reset' : undefined}
    >
      <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
        <span style={{ color: ORANGE }}>{icon}</span>{label}
        {total ? <span className="ml-auto" style={{ color: ORANGE }}>{running ? <Pause size={13} /> : left === 0 ? <RotateCcw size={13} /> : <Play size={13} />}</span> : null}
      </span>
      <span className={`text-[20px] font-semibold tabular-nums ${left === 0 && total ? 'text-emerald-400' : ''}`}>{total ? (left === 0 ? 'Done' : fmtClock(left)) : duration}</span>
      {total ? <GrowBar percent={pct} color={ORANGE} height={4} delay={0} /> : null}
    </button>
  );
};

export const RecipeCard: React.FC<{ data: RecipeData }> = ({ data }) => {
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [step, setStep] = useState(0);
  const meta: Array<[string, string, React.ReactNode]> = [];
  if (data.servings !== undefined) meta.push(['Serves', String(data.servings), <Users size={13} />]);
  if (data.difficulty) meta.push(['Difficulty', data.difficulty, <Signal size={13} />]);
  if (data.calories !== undefined) meta.push(['Calories', `${data.calories} kcal`, <Flame size={13} />]);
  const macros = data.macros ? Object.entries(data.macros).filter(([, v]) => v) : [];
  const done = Object.values(checked).filter(Boolean).length;
  const pct = data.ingredients.length ? Math.round((done / data.ingredients.length) * 100) : 0;

  return (
    <CardShell accent={ORANGE}>
      {data.imageUrl ? (
        <Reveal index={0} className="relative -mx-5 -mt-5 flex h-56 flex-col justify-end overflow-hidden">
          <div className="absolute -inset-6">
            <motion.img src={data.imageUrl} alt="" className="h-full w-full object-cover" initial={{ scale: 1.12 }} animate={{ scale: 1 }} transition={{ duration: 1.4 }} />
          </div>
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0A1522]/20 to-[#0A1522]" />
          <div className="relative flex flex-col gap-2 p-5">
            <div className="flex gap-2">
              {data.cuisine && <Pill label={data.cuisine} color={ORANGE} icon={<Globe size={12} />} />}
              {data.category && <Pill label={data.category} color={palette.warning} icon={<UtensilsCrossed size={12} />} />}
            </div>
            <div className="text-[26px] font-bold leading-tight">{data.title}</div>
          </div>
        </Reveal>
      ) : (
        <Reveal index={0}><div className="text-[20px] font-semibold">{data.title}</div></Reveal>
      )}

      {data.videoUrl && (
        <Reveal index={1}>
          <a href={data.videoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl border border-[#FF0033]/30 bg-[#FF0033]/10 p-3 transition-colors hover:bg-[#FF0033]/20">
            <PlayCircle size={20} className="text-[#FF0033]" />
            <span className="flex-1 text-[13px] font-medium">Watch how it's made</span>
            <ExternalLink size={14} className="text-slate-500" />
          </a>
        </Reveal>
      )}

      {(data.prepTime || data.cookTime) && (
        <Reveal index={2} className="flex gap-2">
          {data.prepTime && <KitchenTimer label="Prep" icon={<Timer size={13} />} duration={data.prepTime} />}
          {data.cookTime && <KitchenTimer label="Cook" icon={<CookingPot size={13} />} duration={data.cookTime} />}
        </Reveal>
      )}

      {meta.length > 0 && (
        <Reveal index={2}>
          <StatGrid>{meta.map(([label, value, icon]) => <Stat key={label} label={label} icon={<span style={{ color: ORANGE }}>{icon}</span>}>{value}</Stat>)}</StatGrid>
        </Reveal>
      )}

      {macros.length > 0 && (() => {
        const kcal = macroCalories(data.macros!);
        const sum = kcal.protein + kcal.carbs + kcal.fat;
        return (
          <Reveal index={3} className="flex flex-col gap-2">
            <SectionLabel icon={<PieChart size={13} style={{ color: ORANGE }} />}>Macros</SectionLabel>
            {sum > 0 && (
              <div className="flex h-[18px] overflow-hidden rounded-full">
                {(Object.keys(kcal) as Array<keyof typeof kcal>).filter((k) => kcal[k] > 0).map((k) => (
                  <motion.div key={k} className="text-center text-[11px] font-extrabold leading-[18px] text-[#02060C]" style={{ background: MACRO_COLORS[k] }} initial={{ flexGrow: 0 }} animate={{ flexGrow: kcal[k] / sum }} transition={{ duration: 0.8, delay: 0.3 }}>
                    {Math.round((kcal[k] / sum) * 100)}%
                  </motion.div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              {macros.map(([k, v]) => (
                <div key={k} className="flex flex-1 flex-col items-center rounded-lg bg-black/35 p-2">
                  <span className="flex items-center gap-1 text-[11px] text-slate-500"><span className="h-2 w-2 rounded-full" style={{ background: MACRO_COLORS[k] ?? ORANGE }} />{k.charAt(0).toUpperCase() + k.slice(1)}</span>
                  <span className="text-[15px] font-semibold">{v}</span>
                </div>
              ))}
            </div>
          </Reveal>
        );
      })()}

      <Reveal index={4}>
        <div className="mb-2 flex items-center gap-3">
          <div className="flex-1">
            <SectionLabel icon={<ShoppingBasket size={13} style={{ color: ORANGE }} />}>Ingredients</SectionLabel>
            <div className="-mt-1 text-[12px] text-slate-500">Tick what you have ready · {done}/{data.ingredients.length}</div>
          </div>
          <RingGauge percent={pct} color={pct === 100 ? palette.success : ORANGE} size={58} stroke={6} />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {data.ingredients.map((ing, i) => {
            const on = !!checked[i];
            return (
              <motion.button
                key={`${ing.item}-${i}`}
                whileTap={{ scale: 0.97 }}
                onClick={() => setChecked((c) => ({ ...c, [i]: !c[i] }))}
                className={`flex items-center gap-3 rounded-xl p-3 text-left transition-colors ${on ? 'bg-emerald-400/15' : 'bg-black/35 hover:bg-black/50'}`}
                role="checkbox"
                aria-checked={on}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span key={on ? 'on' : 'off'} initial={{ scale: 0.4 }} animate={{ scale: 1 }} exit={{ scale: 0.4 }} transition={{ type: 'spring', damping: 12 }}>
                    {on ? <CircleCheck size={19} className="text-emerald-400" /> : <Circle size={19} className="text-slate-500" />}
                  </motion.span>
                </AnimatePresence>
                <span className={`text-[14px] ${on ? 'text-slate-500 line-through' : ''}`}>{ing.amount ? `${ing.amount} ` : ''}{ing.item}</span>
              </motion.button>
            );
          })}
        </div>
      </Reveal>

      {data.steps.length > 0 && (
        <Reveal index={5}>
          <SectionLabel icon={<ListOrdered size={13} style={{ color: ORANGE }} />}>{`Steps · ${Math.min(step + 1, data.steps.length)} of ${data.steps.length}`}</SectionLabel>
          <div className="flex flex-col gap-2">
            {data.steps.map((s, i) => {
              const state = i < step ? 'done' : i === step ? 'current' : 'next';
              return (
                <motion.button
                  key={i}
                  layout
                  onClick={() => setStep(i === step ? i + 1 : i)}
                  className={`flex items-start gap-3 rounded-xl p-2 text-left transition-colors ${state === 'current' ? 'border border-orange-400/40 bg-orange-400/10' : 'hover:bg-white/5'}`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold" style={{ background: state === 'current' ? ORANGE : state === 'done' ? `${palette.success}26` : `${ORANGE}22`, color: state === 'current' ? '#02060C' : ORANGE }}>
                    {state === 'done' ? <Check size={14} className="text-emerald-400" /> : i + 1}
                  </span>
                  <span className={state === 'current' ? 'text-[15px]' : state === 'done' ? 'text-[14px] text-slate-500' : 'text-[14px]'}>{s}</span>
                </motion.button>
              );
            })}
          </div>
          {step >= data.steps.length && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-3 flex items-center gap-2 text-[13px] text-emerald-400">
              <PartyPopper size={16} /> All steps done — enjoy!
            </motion.div>
          )}
        </Reveal>
      )}
    </CardShell>
  );
};
