// The floating dock (mobile Composer + TabBar mic): ask Jarvis by text, or talk.
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowUp, AudioLines, Mic, Square, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { alpha, palette, spring } from '../ui';

function MicButton() {
  const isListening = useStore((s) => s.voiceState.isListening);
  const isSpeaking = useStore((s) => s.voiceState.isSpeaking);
  const toggleMic = useStore((s) => s.toggleMic);
  const reduced = useReducedMotion();
  const last = useRef(0);
  const color = isListening ? palette.listening : palette.accent;
  const Icon = isListening ? Square : isSpeaking ? AudioLines : Mic;
  return (
    <div className="relative grid h-[68px] w-[68px] shrink-0 place-items-center">
      {isListening && !reduced && [0, 0.8].map((delay) => (
        <motion.span key={delay} aria-hidden className="absolute inset-0 rounded-full border-2" style={{ borderColor: color }}
          initial={{ opacity: 0.5, scale: 1 }} animate={{ opacity: 0, scale: 1.7 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut', delay }} />
      ))}
      <motion.button
        type="button"
        onClick={() => {
          const now = Date.now();
          if (now - last.current < 450) return; // a double click would toggle twice
          last.current = now;
          toggleMic();
        }}
        aria-label={isListening ? 'Stop listening' : isSpeaking ? 'Interrupt Jarvis' : 'Talk to Jarvis'}
        aria-pressed={isListening}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.9 }}
        transition={spring.bouncy}
        className="relative grid h-[64px] w-[64px] place-items-center rounded-full p-[3px]"
        style={{ background: palette.bg, boxShadow: `0 6px 26px -4px ${alpha(color, 150)}` }}
      >
        <motion.span
          className="grid h-full w-full place-items-center rounded-full"
          animate={{ background: isListening ? 'linear-gradient(150deg, #F87171, #B91C1C)' : 'linear-gradient(150deg, #67E8F9, #0E7490)' }}
          transition={{ duration: 0.3 }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={isListening ? "stop" : isSpeaking ? "wave" : "mic"} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={spring.snappy}
              style={{ color: isListening ? '#FFF1F1' : palette.textInverse }}>
              <Icon size={26} fill={isListening ? 'currentColor' : 'none'} />
            </motion.span>
          </AnimatePresence>
        </motion.span>
      </motion.button>
    </div>
  );
}

function Composer() {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const sendCommand = useStore((s) => s.sendCommand);
  const voiceState = useStore((s) => s.voiceState);
  // While you talk, the box mirrors what Jarvis hears.
  useEffect(() => {
    if (voiceState.isListening && voiceState.role === 'user' && voiceState.transcript) setText(voiceState.transcript);
  }, [voiceState.transcript, voiceState.role, voiceState.isListening]);
  useEffect(() => {
    if (!voiceState.transcript && voiceState.isListening) setText('');
  }, [voiceState.transcript, voiceState.isListening]);
  const send = () => {
    const cmd = text.trim();
    if (!cmd) return;
    sendCommand(cmd);
    setText('');
  };
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); send(); }}
      className="flex h-[54px] min-w-0 flex-1 items-center gap-2.5 rounded-full border pl-5 pr-2 transition-colors"
      style={{ background: focused ? palette.surfaceRaised : palette.surface, borderColor: focused ? alpha(palette.accent, 128) : palette.stroke }}
    >
      <Terminal size={18} style={{ color: focused ? palette.accent : palette.textTertiary }} aria-hidden />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Ask Jarvis anything…"
        aria-label="Command"
        className="min-w-0 flex-1 bg-transparent t-body outline-none placeholder:text-text-3"
      />
      <AnimatePresence>
        {text.trim() && (
          <motion.button type="submit" aria-label="Send command" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0 }} transition={spring.bouncy}
            whileTap={{ scale: 0.88 }} className="grid h-10 w-10 place-items-center rounded-full" style={{ background: palette.accent, color: palette.textInverse }}>
            <ArrowUp size={19} strokeWidth={2.4} />
          </motion.button>
        )}
      </AnimatePresence>
    </form>
  );
}

export function Dock() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4 md:pb-5">
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...spring.gentle, delay: 0.25 }}
        className="glass shadow-float pointer-events-auto flex w-full max-w-[860px] items-center gap-3 rounded-[34px] py-1.5 pl-2 pr-1.5"
      >
        <Composer />
        <MicButton />
      </motion.div>
    </div>
  );
}
