// When the "Hey Jarvis" / double-clap standby listener may run, what its status line says, and
// which triggers count. Pure, shared by the web/desktop listener (src/runtime/wake) and its tests.
import { matchWakePhrase, type WakeMatch } from './wakePhrase.ts';

export type ClapSensitivity = 'less' | 'normal' | 'more';
export const CLAP_SENSITIVITY: Record<ClapSensitivity, number> = { less: 0.7, normal: 1, more: 1.3 };

export interface WakePrefs {
  heyJarvis: boolean;
  clap: boolean;
}

export interface StandbyInputs extends WakePrefs {
  /** The WebSocket to the Jarvis Server is open. */
  connected: boolean;
  /** The main microphone is on (the orb is listening). */
  listening: boolean;
  /** Jarvis is talking. */
  speaking: boolean;
  /** When Jarvis last stopped talking (ms), or null. */
  speakingEndedAt: number | null;
  /** A live avatar call (its own microphone over WebRTC). */
  avatar: boolean;
  now: number;
}

export type PauseReason = 'off' | 'offline' | 'listening' | 'speaking' | 'avatar';

export type StandbyDecision =
  | { run: true }
  | { run: false; reason: PauseReason; /** Check again at this time (ms) — the end of the after-speech quiet. */ recheckAt?: number };

/** Jarvis's own voice still echoes for a moment after it stops: wait this long. */
export const AFTER_SPEECH_MS = 1000;
/** One trigger at a time. */
export const TRIGGER_DEBOUNCE_MS = 2000;
/** Just (re)connected: the page is settling, nothing triggers yet. */
export const AFTER_CONNECT_MS = 1000;

/** Should the standby listener hold the microphone now? */
export function standbyDecision(s: StandbyInputs): StandbyDecision {
  if (!s.heyJarvis && !s.clap) return { run: false, reason: 'off' };
  if (!s.connected) return { run: false, reason: 'offline' };
  if (s.avatar) return { run: false, reason: 'avatar' };
  if (s.listening) return { run: false, reason: 'listening' };
  if (s.speaking) return { run: false, reason: 'speaking' };
  if (s.speakingEndedAt !== null && s.now - s.speakingEndedAt < AFTER_SPEECH_MS) {
    return { run: false, reason: 'speaking', recheckAt: s.speakingEndedAt + AFTER_SPEECH_MS };
  }
  return { run: true };
}

/** A detection may start listening: not right after another one, not while (re)connecting. */
export function triggerAllowed(now: number, lastTriggerAt: number | null, connectedAt: number | null): boolean {
  if (connectedAt === null || now - connectedAt < AFTER_CONNECT_MS) return false;
  return lastTriggerAt === null || now - lastTriggerAt >= TRIGGER_DEBOUNCE_MS;
}

/** What the listener is doing (the Settings status line and the indicator by the orb). */
export type StandbyPhase =
  | { kind: 'off' }
  | { kind: 'paused'; reason: Exclude<PauseReason, 'off'> }
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'needs-gesture' }
  | { kind: 'mic-blocked' }
  | { kind: 'mic-error'; message: string };

export type ModelState =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'preparing' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const listeningFor = (p: WakePrefs) =>
  p.heyJarvis && p.clap ? 'Listening for “Hey Jarvis” and two claps'
    : p.heyJarvis ? 'Listening for “Hey Jarvis”'
      : 'Listening for two claps';

/** The status line. `heard` (a test or a trigger a moment ago) wins while it's fresh. */
export function standbyStatusText(prefs: WakePrefs, phase: StandbyPhase, model: ModelState, heard?: string | null): string {
  if (heard) return heard;
  if (phase.kind === 'off' || (!prefs.heyJarvis && !prefs.clap)) return 'Off';
  if (phase.kind === 'mic-blocked') return 'Microphone blocked — allow it in the browser/system settings';
  if (phase.kind === 'mic-error') return `Microphone unavailable — ${phase.message}`;
  if (phase.kind === 'needs-gesture') return 'Click anywhere in Jarvis to start listening';
  // Downloading the model: claps already work meanwhile.
  if (prefs.heyJarvis && model.kind === 'downloading') {
    const pct = `Downloading the on-device model… ${Math.round(model.percent)}%`;
    return prefs.clap && phase.kind === 'running' ? `${pct} · two claps work already` : pct;
  }
  if (prefs.heyJarvis && model.kind === 'preparing') return 'Preparing the on-device model…';
  if (phase.kind === 'paused') {
    switch (phase.reason) {
      case 'offline': return 'Paused — not connected to Jarvis';
      case 'listening': return 'Paused — Jarvis is listening';
      case 'speaking': return 'Paused while Jarvis is talking';
      case 'avatar': return 'Paused during the live avatar call';
    }
  }
  if (phase.kind === 'starting') return 'Starting the microphone…';
  if (prefs.heyJarvis && model.kind === 'error') {
    return prefs.clap ? `“Hey Jarvis” unavailable (${model.message}) — two claps still work` : `“Hey Jarvis” unavailable — ${model.message}`;
  }
  return listeningFor(prefs);
}

/** The hint by the orb while standby listens, else null. */
export function standbyHint(prefs: WakePrefs, phase: StandbyPhase, model: ModelState): string | null {
  if (phase.kind !== 'running') return null;
  const wake = prefs.heyJarvis && model.kind === 'ready';
  if (wake && prefs.clap) return 'Say “Hey Jarvis” or clap twice';
  if (wake) return 'Say “Hey Jarvis”';
  if (prefs.clap) return 'Clap twice to talk';
  return null;
}

/** Tokens Moonshine may generate for `seconds` of audio (its own default rounds 0.9 s down to 0). */
export function maxTokensFor(seconds: number): number {
  return Math.min(96, Math.ceil(seconds * 7) + 4);
}

/**
 * A speech segment's verdict. Short segments have only a final; long ones (speechSegmenter) had a
 * probe (their first 2.5 s) — `probeText` — then the final (all of it). The probe decides
 * whether it called Jarvis; the final gives the whole request after the name, and when the model
 * garbles the long version, the probe's request is used.
 */
export function resolveWake(probeText: string | undefined, finalText: string): WakeMatch | null {
  if (probeText === undefined) return matchWakePhrase(finalText);
  const probe = matchWakePhrase(probeText);
  if (!probe) return null;
  return matchWakePhrase(finalText) ?? probe;
}
