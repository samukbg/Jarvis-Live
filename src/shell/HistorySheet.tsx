// The results history (mobile ResultHistorySheet): every result card Jarvis showed on this
// device, newest first, grouped by day — tap one to open its card again.
import { AnimatePresence, motion } from 'framer-motion';
import {
  BarChart3, Briefcase, ChefHat, ChevronRight, CloudSun, Cpu, History, Languages, ListChecks, MessageSquare, Music, Plane, Trash2, TrendingUp, Trophy, Wallet, X,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { dayLabel, type ResultHistoryEntry } from '../components/overlayCards/resultHistory';
import { LABELS } from '../components/overlayCards/SpecialCardRenderer';
import type { SpecialContentType } from '../components/overlayCards/types';
import { Pressable, Sheet, alpha, palette, spring } from '../ui';

const TYPE_ICON: Record<SpecialContentType, LucideIcon> = {
  weather: CloudSun,
  finance: TrendingUp,
  flight: Plane,
  system: Cpu,
  task_roadmap: ListChecks,
  media_audio: Music,
  translation: Languages,
  chart: BarChart3,
  sports: Trophy,
  recipe: ChefHat,
  wallet: Wallet,
  business_dashboard: Briefcase,
};

/** Icon, label and colour for an entry's card type (a plain answer: a speech bubble). */
function entryLook(type: SpecialContentType | null) {
  if (!type) return { icon: MessageSquare, label: 'Answer', color: palette.accent };
  const l = LABELS[type] ?? { label: 'Result', color: palette.accent };
  return { icon: TYPE_ICON[type] ?? MessageSquare, label: l.label, color: l.color };
}

const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "JARVIS" → "Jarvis"; names already in mixed case stay as they are. */
const displayName = (name: string) => (name.length > 3 && name === name.toUpperCase() ? name.charAt(0) + name.slice(1).toLowerCase() : name);

function HistoryRow({ entry, onOpen, onRemove }: { entry: ResultHistoryEntry; onOpen: () => void; onRemove: () => void }) {
  const look = entryLook(entry.type);
  const Icon = look.icon;
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24, height: 0, transition: { duration: 0.2 } }}
      transition={spring.snappy}
      className="group relative overflow-hidden"
    >
      <Pressable
        pressedScale={0.985}
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-[16px] py-2.5 pl-2.5 pr-2 text-left transition-colors hover:bg-[rgba(148,210,255,0.06)] focus-visible:bg-[rgba(148,210,255,0.06)] focus-visible:outline-none"
        aria-label={`${look.label}: ${entry.title}`}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] border" style={{ background: alpha(look.color, 30), borderColor: alpha(look.color, 60), color: look.color }}>
          <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate t-callout" style={{ color: palette.text }}>{entry.title}</span>
          <span className="flex min-w-0 items-center gap-1 t-footnote" style={{ color: palette.textTertiary }}>
            <span className="shrink-0" style={{ color: alpha(look.color, 220) }}>{look.label}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{displayName(entry.agentName)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular">{timeOf(entry.at)}</span>
          </span>
        </span>
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center transition-opacity group-hover:opacity-0 [@media(hover:none)]:opacity-0" style={{ color: palette.textTertiary }}>
          <ChevronRight size={16} />
        </span>
      </Pressable>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove “${entry.title}” from history`}
        title="Remove from history"
        className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full opacity-0 transition-[opacity,background-color,color] hover:bg-[rgba(239,68,68,0.16)] hover:text-[#F87171] focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        style={{ color: palette.textTertiary }}
      >
        <X size={15} />
      </button>
    </motion.li>
  );
}

function EmptyState() {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle} className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-4 grid h-16 w-16 place-items-center rounded-[22px] border" style={{ background: alpha(palette.accent, 22), borderColor: alpha(palette.accent, 60), color: palette.accent }}>
        <History size={28} />
      </span>
      <h3 className="t-headline">No results yet</h3>
      <p className="mt-1 max-w-[320px] t-callout" style={{ color: palette.textSecondary }}>
        Ask Jarvis something — its answer cards are kept here so you can open them again.
      </p>
    </motion.div>
  );
}

export function HistorySheet() {
  const open = useStore((s) => s.historyOpen);
  const setOpen = useStore((s) => s.setHistoryOpen);
  const history = useStore((s) => s.resultHistory);
  const openFromHistory = useStore((s) => s.openFromHistory);
  const removeFromHistory = useStore((s) => s.removeFromHistory);
  const clearHistory = useStore((s) => s.clearHistory);
  const [confirming, setConfirming] = useState(false);
  const close = () => { setConfirming(false); setOpen(false); };

  const groups = useMemo(() => {
    const out: { label: string; items: ResultHistoryEntry[] }[] = [];
    for (const e of history) {
      const label = dayLabel(e.at);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [history]);

  const count = history.length;
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Results history"
      subtitle="Cards Jarvis showed you, on this device"
      icon={History}
      width={640}
      footer={count > 0 ? (
        <div className="flex min-h-10 items-center justify-between gap-3">
          <span className="t-footnote tabular" style={{ color: palette.textTertiary }}>{count} {count === 1 ? 'result' : 'results'}</span>
          <AnimatePresence mode="wait" initial={false}>
            {confirming ? (
              <motion.div key="confirm" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.16 }} className="flex items-center gap-2">
                <span className="hidden t-subhead sm:inline" style={{ color: palette.textSecondary }}>Clear all {count}?</span>
                <Pressable onClick={() => setConfirming(false)} className="h-10 rounded-full px-4 t-subhead" style={{ background: palette.surfaceRaised, color: palette.textSecondary }}>Cancel</Pressable>
                <Pressable onClick={() => { clearHistory(); setConfirming(false); }} className="flex h-10 items-center gap-1.5 rounded-full px-4 t-subhead" style={{ background: alpha(palette.listening, 46), color: '#FCA5A5', border: `1px solid ${alpha(palette.listening, 110)}` }}>
                  <Trash2 size={14} /> Clear
                </Pressable>
              </motion.div>
            ) : (
              <motion.div key="clear" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
                <Pressable onClick={() => setConfirming(true)} className="flex h-10 items-center gap-1.5 rounded-full px-4 t-subhead transition-colors hover:text-[#FCA5A5]" style={{ background: palette.surfaceRaised, color: palette.textSecondary }}>
                  <Trash2 size={14} /> Clear history
                </Pressable>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : undefined}
    >
      {count === 0 ? <EmptyState /> : (
        <div className="flex flex-col gap-4 pt-1">
          <AnimatePresence initial={false}>
            {groups.map((g) => (
              <motion.section key={g.label} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={spring.snappy}>
                <h3 className="mb-1.5 px-1 t-eyebrow" style={{ color: palette.textTertiary }}>{g.label}</h3>
                <ul className="surface flex flex-col p-1.5">
                  <AnimatePresence initial={false}>
                    {g.items.map((e) => (
                      <HistoryRow key={e.id} entry={e} onOpen={() => { setConfirming(false); openFromHistory(e); }} onRemove={() => removeFromHistory(e.id)} />
                    ))}
                  </AnimatePresence>
                </ul>
              </motion.section>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Sheet>
  );
}
