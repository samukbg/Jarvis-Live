// The mobile app's design tokens (mobile-app/src/theme.ts), for the web: one palette, one
// motion language. Semantic colours double as Jarvis's voice states.
import type { Transition } from 'framer-motion';

export const palette = {
  bg: '#02060C',
  surface: '#0A1522',
  surfaceRaised: '#0F1D2E',
  surfaceHigh: '#16283D',
  stroke: 'rgba(148, 210, 255, 0.10)',
  strokeStrong: 'rgba(148, 210, 255, 0.20)',
  text: '#EAF6FF',
  textSecondary: 'rgba(226, 242, 255, 0.66)',
  textTertiary: 'rgba(226, 242, 255, 0.42)',
  textInverse: '#02121A',
  muted: '#7C8DA0',
  accent: '#22D3EE',
  accentStrong: '#67E8F9',
  listening: '#EF4444',
  success: '#34D399',
  warning: '#FBBF24',
  violet: '#A855F7',
  gemini: '#818CF8',
  claude: '#F59E0B',
} as const;

/** Spring presets, same physics as the mobile app's Reanimated springs. */
export const spring = {
  snappy: { type: 'spring', damping: 18, stiffness: 260, mass: 0.8 },
  gentle: { type: 'spring', damping: 20, stiffness: 140, mass: 1 },
  bouncy: { type: 'spring', damping: 12, stiffness: 180, mass: 0.9 },
} satisfies Record<string, Transition>;

export const ease = {
  emphasized: [0.2, 0, 0, 1] as [number, number, number, number],
  standard: [0.4, 0, 0.2, 1] as [number, number, number, number],
};

export const duration = { fast: 0.16, base: 0.24, slow: 0.42 };

/** Staggered entrance (mobile `FadeInDown.delay(60 + i * 70).springify()`). */
export const enter = (i: number) => ({
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
  transition: { ...spring.gentle, delay: 0.06 + i * 0.07 },
});

/** Hex colour + alpha (0-255) as a CSS colour. */
export const alpha = (hex: string, a: number) => `${hex}${Math.round(a).toString(16).padStart(2, '0')}`;
