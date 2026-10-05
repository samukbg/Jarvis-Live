import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Disc3, Timer, Tag, Calendar, BadgeCheck, FileText, SkipBack, SkipForward, Play, Pause, Music2 } from 'lucide-react';
import type { MediaAudioData } from './types';
import { clock, sendMediaAction, type CardLive, type MediaAction } from './enrichment';
import { API_KEY, BACKEND_HTTP } from '../../store';
import { CardShell, Reveal, SectionLabel, Stat, StatGrid } from './kit';


const PINK = '#F472B6';

/** Playback position, advanced locally between live refreshes. */
function usePosition(data: MediaAudioData, fetchedAt?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!data.isPlaying) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [data.isPlaying]);
  if (data.positionSec === undefined) return undefined;
  const elapsed = data.isPlaying && fetchedAt ? (now - fetchedAt) / 1000 : 0;
  return Math.min(data.durationSec ?? Infinity, data.positionSec + Math.max(0, elapsed));
}

export const MediaAudioCard: React.FC<{ data: MediaAudioData; live?: CardLive }> = ({ data, live }) => {
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const position = usePosition(data, live?.fetchedAt);
  const controllable = data.source === 'spotify';

  const act = async (action: MediaAction) => {
    setBusy(true);
    await sendMediaAction(BACKEND_HTTP, API_KEY, action).catch(() => {});
    live?.refresh();
    setTimeout(() => setBusy(false), 400);
  };

  const meta: Array<[string, string, React.ReactNode]> = [];
  if (data.duration || (data.durationSec && position === undefined)) meta.push(['Duration', data.duration ?? clock(data.durationSec!), <Timer size={13} />]);
  if (data.genre) meta.push(['Genre', data.genre, <Tag size={13} />]);
  if (data.releaseYear) meta.push(['Released', data.releaseYear, <Calendar size={13} />]);
  if (data.audioQuality) meta.push(['Quality', data.audioQuality, <BadgeCheck size={13} />]);

  const lyrics = data.lyrics ?? [];
  const synced = !!data.lyricsSynced && position !== undefined;
  const activeIdx = synced ? lyrics.reduce((acc, l, i) => (l.t !== undefined && l.t <= position! ? i : acc), -1) : -1;
  const start = Math.max(0, activeIdx - 1);
  const shown = synced
    ? lyrics.slice(start, start + 5).map((l, k) => ({ ...l, idx: start + k }))
    : (showAll ? lyrics : lyrics.slice(0, 8)).map((l, idx) => ({ ...l, idx }));
  const progress = position !== undefined && data.durationSec ? Math.min(100, (position / data.durationSec) * 100) : undefined;

  return (
    <CardShell
      accent={PINK}
      ambient={data.coverUrl ? (
        <div className="pointer-events-none absolute -inset-10 h-80 opacity-35">
          <img src={data.coverUrl} alt="" className="h-full w-full object-cover blur-3xl" />
        </div>
      ) : undefined}
    >
      <div>
        <Reveal index={0} className="flex items-center gap-4">
          {/* Vinyl record with the artwork as its label; turns while the track plays. */}
          <motion.div
            className="relative flex h-32 w-32 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#0b0b10] shadow-2xl"
            animate={{ rotate: 360 }}
            transition={{ duration: data.isPlaying === false ? 0 : 3.6, repeat: data.isPlaying === false ? 0 : Infinity, ease: 'linear' }}
          >
            {[0.94, 0.82, 0.7, 0.58].map((k) => (
              <span key={k} className="absolute rounded-full border border-white/[0.07]" style={{ width: `${k * 100}%`, height: `${k * 100}%` }} />
            ))}
            <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-pink-400/25">
              {data.coverUrl ? <img src={data.coverUrl} alt="" className="h-full w-full object-cover" /> : <Music2 size={22} style={{ color: PINK }} />}
            </span>
            <span className="absolute h-2 w-2 rounded-full bg-zinc-300" />
          </motion.div>
          <div className="flex min-w-0 flex-col gap-0.5">
            {controllable && (
              <span className="flex items-center gap-1 text-[11px] font-semibold text-[#1DB954]">
                <Music2 size={12} /> {data.isPlaying ? 'Playing on Spotify' : 'Paused on Spotify'}
              </span>
            )}
            <div className="line-clamp-2 text-[20px] font-semibold leading-tight">{data.title}</div>
            {data.artist && <div className="truncate text-[16px] font-semibold" style={{ color: PINK }}>{data.artist}</div>}
            {data.album && (
              <div className="flex items-center gap-1.5 truncate text-[12px] text-slate-400">
                <Disc3 size={13} /> <span className="truncate">{data.album}</span>
              </div>
            )}
            {data.audioQuality && (
              <span className="mt-1 inline-flex w-fit items-center gap-1 rounded border border-amber-200/50 px-1.5 py-0.5 text-[11px] font-extrabold tracking-wide text-amber-200">
                <BadgeCheck size={11} /> {data.audioQuality}
              </span>
            )}
            {/* Visualizer: decorative bars that dance while the track plays. */}
            <div className="mt-1.5 flex h-6 items-end gap-[2px]" aria-hidden>
              {Array.from({ length: 18 }, (_, i) => (
                <motion.span
                  key={i}
                  className="flex-1 rounded-sm"
                  style={{ background: PINK, opacity: 0.85 }}
                  animate={data.isPlaying === false ? { height: '18%' } : { height: ['20%', `${35 + ((i * 37) % 60)}%`, '20%'] }}
                  transition={{ duration: 0.8 + (i % 3) * 0.18, repeat: Infinity, ease: 'easeInOut', delay: i * 0.06 }}
                />
              ))}
            </div>
          </div>
        </Reveal>
      </div>

      {progress !== undefined && (
        <Reveal index={1} className="flex flex-col gap-1.5">
          <div className="relative flex h-1.5 items-center rounded-full bg-white/10">
            <motion.div className="absolute left-0 h-1.5 rounded-full" style={{ background: PINK }} animate={{ width: `${progress}%` }} transition={{ duration: 0.5, ease: 'linear' }} />
            <motion.span className="absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white shadow" animate={{ left: `${progress}%` }} transition={{ duration: 0.5, ease: 'linear' }} />
          </div>
          <div className="flex justify-between text-[11px] tabular-nums">
            <span className="text-slate-300">{clock(position!)}</span>
            <span className="text-slate-500">−{clock(data.durationSec! - position!)}</span>
          </div>
        </Reveal>
      )}

      {controllable && (
        <Reveal index={2} className="flex items-center justify-center gap-6">
          <motion.button whileTap={{ scale: 0.9 }} whileHover={{ scale: 1.06 }} disabled={busy} onClick={() => act('prev')} className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 disabled:opacity-50" aria-label="Previous track">
            <SkipBack size={22} />
          </motion.button>
          <motion.button whileTap={{ scale: 0.88 }} whileHover={{ scale: 1.06 }} disabled={busy} onClick={() => act('toggle')} className="flex h-16 w-16 items-center justify-center rounded-full text-[#02060C] disabled:opacity-50" style={{ background: PINK, boxShadow: `0 0 28px ${PINK}66` }} aria-label={data.isPlaying ? 'Pause' : 'Play'}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={data.isPlaying ? 'pause' : 'play'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.15 }}>
                {data.isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
              </motion.span>
            </AnimatePresence>
          </motion.button>
          <motion.button whileTap={{ scale: 0.9 }} whileHover={{ scale: 1.06 }} disabled={busy} onClick={() => act('next')} className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 disabled:opacity-50" aria-label="Next track">
            <SkipForward size={22} />
          </motion.button>
        </Reveal>
      )}

      {meta.length > 0 && (
        <Reveal index={3}>
          <StatGrid>
            {meta.map(([label, value, icon]) => <Stat key={label} label={label} icon={<span style={{ color: PINK }}>{icon}</span>}>{value}</Stat>)}
          </StatGrid>
        </Reveal>
      )}

      {lyrics.length > 0 && (
        <Reveal index={4}>
          <SectionLabel icon={<FileText size={13} style={{ color: PINK }} />}>{synced ? 'Lyrics · in sync' : 'Lyrics'}</SectionLabel>
          <div className="flex min-h-[60px] flex-col gap-2">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((l) => {
                const active = l.idx === activeIdx;
                const past = synced && l.idx < activeIdx;
                return (
                  <motion.div
                    key={l.idx}
                    layout
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -12 }}
                    transition={{ type: 'spring', damping: 22, stiffness: 220 }}
                    className={active ? 'text-[20px] font-semibold' : past ? 'text-[14px] text-slate-500' : 'text-[14px] text-slate-300'}
                    style={active ? { color: PINK } : undefined}
                  >
                    {l.text}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
          {!synced && lyrics.length > 8 && (
            <button onClick={() => setShowAll((v) => !v)} className="mt-2 text-[13px] font-semibold" style={{ color: PINK }}>
              {showAll ? 'Show less' : `Show all ${lyrics.length} lines`}
            </button>
          )}
        </Reveal>
      )}
    </CardShell>
  );
};
