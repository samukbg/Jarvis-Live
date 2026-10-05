import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Copy, Check, Repeat, GraduationCap, Volume2 } from 'lucide-react';
import type { TranslationData } from './types';
import { CardShell, Reveal, SectionLabel, palette } from './kit';


export const TranslationCard: React.FC<{ data: TranslationData }> = ({ data }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(data.translatedText).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  const words = data.translatedText.split(/\s+/).filter(Boolean);
  return (
    <CardShell accent={palette.warning}>
      <Reveal index={0} className="flex items-center gap-3">
        <div className="flex flex-1 items-center gap-2 text-[14px] font-semibold">
          {data.sourceLang && <span className="rounded-full bg-black/40 px-2.5 py-0.5 text-slate-300">{data.sourceLang}</span>}
          {data.sourceLang && data.targetLang && (
            <motion.span animate={{ x: [0, 4, 0] }} transition={{ duration: 1.4, repeat: Infinity, delay: 0.6 }}>
              <ArrowRight size={16} className="text-amber-400" />
            </motion.span>
          )}
          {data.targetLang && <span className="rounded-full bg-amber-400/15 px-2.5 py-0.5 text-amber-400">{data.targetLang}</span>}
        </div>
        <button onClick={copy} className="flex items-center gap-1.5 rounded-full bg-amber-400/15 px-3 py-1.5 text-[13px] font-semibold text-amber-400 transition-transform active:scale-95">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={String(copied)} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} className="flex items-center gap-1.5">
              {copied ? <><Check size={14} className="text-emerald-400" /> <span className="text-emerald-400">Copied</span></> : <><Copy size={14} /> Copy</>}
            </motion.span>
          </AnimatePresence>
        </button>
      </Reveal>
      {/* Dual-pane matrix: original and translation side by side. */}
      <Reveal index={1} className={`grid gap-2 ${data.sourceText ? 'grid-cols-[1fr_auto_1fr]' : 'grid-cols-1'}`}>
        {data.sourceText && (
          <div className="flex flex-col gap-1 rounded-xl bg-black/35 p-3">
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{data.sourceLang ?? 'Original'}</span>
            <p className="text-[14px] text-slate-300">{data.sourceText}</p>
          </div>
        )}
        {data.sourceText && <ArrowRight size={18} className="self-center text-amber-400" />}
        <div className="flex flex-col gap-1 rounded-xl border border-amber-400/40 bg-black/35 p-3">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-amber-400">{data.targetLang ?? 'Translation'}</span>
          {/* Words fade up one after another. */}
          <p className="flex flex-wrap gap-x-1.5 text-[17px] font-semibold">
            {words.map((w, i) => (
              <motion.span key={`${w}-${i}`} initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ delay: 0.25 + i * 0.055, duration: 0.32 }}>
                {w}
              </motion.span>
            ))}
          </p>
        </div>
      </Reveal>
      {data.phonetic && (
        <Reveal index={2} className="flex items-center gap-2 rounded-xl bg-black/35 p-3">
          <Volume2 size={15} className="text-amber-400" />
          <div>
            <div className="text-[11px] text-slate-500">Pronunciation (IPA)</div>
            <div className="text-[14px] italic">{data.phonetic}</div>
          </div>
        </Reveal>
      )}
      {data.alternatives && data.alternatives.length > 0 && (
        <Reveal index={3}>
          <SectionLabel icon={<Repeat size={13} className="text-amber-400" />}>Alternatives</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {data.alternatives.map((a, i) => (
              <motion.span key={i} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.5 + i * 0.08 }} className="rounded-full border border-amber-400/25 bg-black/40 px-3 py-1.5 text-[14px]">
                {a}
              </motion.span>
            ))}
          </div>
        </Reveal>
      )}
      {data.grammarNotes && data.grammarNotes.length > 0 && (
        <Reveal index={4}>
          <SectionLabel icon={<GraduationCap size={13} className="text-amber-400" />}>Notes</SectionLabel>
          {data.grammarNotes.map((n, i) => <p key={i} className="text-[14px] text-slate-300">• {n}</p>)}
        </Reveal>
      )}
    </CardShell>
  );
};
