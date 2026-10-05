// The ambient background: two aurora glows and a faint dot field on deep navy, each layer
// drifting with the pointer at its own depth (parallax). The main glow takes the voice state's
// colour — red while listening, violet while agents work — so the whole room reacts.
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from 'framer-motion';
import { useEffect } from 'react';
import { alpha, palette } from '../ui/theme';
import { useVoiceStatus } from './status';

/** Pointer position in [-1, 1] (springy), shared by parallax layers. */
export function usePointer(): { x: MotionValue<number>; y: MotionValue<number> } {
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    const move = (e: PointerEvent) => {
      rx.set((e.clientX / window.innerWidth) * 2 - 1);
      ry.set((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => window.removeEventListener('pointermove', move);
  }, [rx, ry, reduced]);
  return { x: useSpring(rx, { stiffness: 60, damping: 20, mass: 0.8 }), y: useSpring(ry, { stiffness: 60, damping: 20, mass: 0.8 }) };
}

export function Backdrop() {
  const { x, y } = usePointer();
  const status = useVoiceStatus();
  const glow = status.label === 'Online' || status.label === 'Offline' || status.label === 'Speaking' ? palette.accent : status.color;
  const farX = useTransform(x, (v) => v * -14);
  const farY = useTransform(y, (v) => v * -10);
  const nearX = useTransform(x, (v) => v * -34);
  const nearY = useTransform(y, (v) => v * -24);
  const dotsX = useTransform(x, (v) => v * -6);
  const dotsY = useTransform(y, (v) => v * -6);

  return (
    <div aria-hidden className="grain pointer-events-none fixed inset-0 z-0 overflow-hidden" style={{ background: palette.bg }}>
      <motion.div className="absolute inset-[-10%]" style={{ x: dotsX, y: dotsY, backgroundImage: 'radial-gradient(rgba(148,210,255,0.07) 1px, transparent 1px)', backgroundSize: '28px 28px', maskImage: 'radial-gradient(70% 60% at 50% 40%, black, transparent)' }} />
      <motion.div
        className="absolute left-[-15%] top-[-25%] h-[75vh] w-[75vw] rounded-full blur-[110px]"
        style={{ x: farX, y: farY }}
        animate={{ background: `radial-gradient(closest-side, ${alpha(glow, 60)}, transparent)` }}
        transition={{ duration: 1.2 }}
      />
      <motion.div
        className="absolute bottom-[-30%] right-[-20%] h-[80vh] w-[70vw] rounded-full blur-[120px]"
        style={{ x: nearX, y: nearY, background: `radial-gradient(closest-side, ${alpha(palette.violet, 34)}, transparent)` }}
        animate={{ scale: [1, 1.08, 1] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute inset-x-0 top-0 h-48" style={{ background: `linear-gradient(${alpha('#000000', 80)}, transparent)` }} />
    </div>
  );
}
