// Hands-free activation: say "Hey Jarvis" or clap twice and Jarvis starts listening, exactly
// like clicking the orb. The standby listener holds the microphone only while it may trigger
// (a mode on, connected, not already listening, Jarvis quiet for a second, no avatar call) and
// releases it otherwise, so the main capture and the avatar never share it. Sound is analysed on
// this device; nothing is sent until Jarvis hears its name or two claps.
import { create } from 'zustand';
import { useStore } from '../../store';
import {
  CLAP_SENSITIVITY, resolveWake, standbyDecision, triggerAllowed,
  type ModelState, type StandbyDecision, type StandbyPhase, type WakePrefs,
} from '../../server/wakeStandby';
import { matchWakePhrase } from '../../server/wakePhrase';
import { SEGMENT } from '../../server/speechSegmenter';
import { WakeAsr } from './wakeAsr';
import { WakeListener, type MicFailure } from './wakeListener';
import { playChime } from './chime';

export interface WakeDetection {
  kind: 'clap' | 'wake';
  /** What followed "Hey Jarvis". */
  rest?: string;
  transcript?: string;
  /** Model time for the final segment (ms). */
  asrMs?: number;
  /** From the end of the speech (or the second clap) to the trigger (ms), estimated. */
  latencyMs: number;
  at: number;
  /** A test from Settings: nothing was started. */
  test: boolean;
}

interface WakeStatus {
  phase: StandbyPhase;
  model: ModelState;
  /** "Heard two claps" for a moment after a detection. */
  heard: string | null;
  /** Settings' Test: detections only show here, nothing starts. */
  testing: boolean;
  last: WakeDetection | null;
}

export const useWakeStatus = create<WakeStatus>(() => ({ phase: { kind: 'off' }, model: { kind: 'idle' }, heard: null, testing: false, last: null }));

const TEST_MS = 15000;
const HEARD_MS = 2500;
/** The clap detector fires this long after the second clap (its guard time). */
const CLAP_GUARD_MS = 350;

let stopCurrent: (() => void) | null = null;
let testHook: (() => void) | null = null;
let retryHook: (() => void) | null = null;

/** Settings' Test: for a few seconds detections only show in the status line. */
export function testWake() {
  testHook?.();
}

/** Try the microphone / model again (after allowing the mic, or a failed download). */
export function retryWake() {
  retryHook?.();
}

/** Starts the standby controller (once; the returned function stops it). */
export function startWakeStandby(): () => void {
  if (stopCurrent) return stopCurrent;
  const setStatus = (s: Partial<WakeStatus>) => useWakeStatus.setState(s);

  let speakingEndedAt: number | null = null;
  let connectedAt: number | null = useStore.getState().wsConnected ? Date.now() : null;
  let lastTriggerAt: number | null = null;
  let micFailure: MicFailure | null = null;
  let audioState: 'running' | 'needs-gesture' = 'running';
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  let heardTimer: ReturnType<typeof setTimeout> | undefined;
  let testTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** Long segments: their probe's transcript (null: failed). */
  const probes = new Map<number, Promise<string | null>>();

  const prefs = (): WakePrefs => {
    const s = useStore.getState();
    return { heyJarvis: s.wakeHeyJarvis, clap: s.wakeClap };
  };

  const asr = new WakeAsr((model) => {
    setStatus({ model });
    if (model.kind === 'ready') evaluate(); // speech segments only once the model can hear them
  });

  const listener = new WakeListener({
    onClap: () => detected({ kind: 'clap', latencyMs: CLAP_GUARD_MS }),
    onSegment: (seg) => { void onSegment(seg); },
    onAudioState: (state) => {
      audioState = state;
      if (listener.active) setStatus({ phase: state === 'running' ? { kind: 'running' } : { kind: 'needs-gesture' } });
    },
    onEnded: () => {
      listener.stop();
      setTimeout(evaluate, 1000);
    },
  });

  const decide = () => {
    const s = useStore.getState();
    return standbyDecision({
      ...prefs(),
      connected: s.wsConnected,
      listening: s.voiceState.isListening,
      speaking: s.voiceState.isSpeaking,
      speakingEndedAt,
      avatar: s.avatarMode,
      now: Date.now(),
    });
  };

  const config = () => {
    const s = useStore.getState();
    return { clap: s.wakeClap, speech: s.wakeHeyJarvis && asr.ready, sensitivity: CLAP_SENSITIVITY[s.clapSensitivity] ?? 1 };
  };

  function evaluate() {
    if (stopped) return;
    clearTimeout(recheckTimer);
    const p = prefs();
    // The model exists only while "Hey Jarvis" is on (loaded lazily, kept while paused).
    if (p.heyJarvis && asr.state.kind === 'idle') asr.load();
    else if (!p.heyJarvis && asr.state.kind !== 'idle') asr.dispose();

    const d = decide();
    if (!d.run) {
      // (no strictNullChecks in this project: a boolean discriminant doesn't narrow by itself)
      const { reason, recheckAt } = d as Extract<StandbyDecision, { run: false }>;
      listener.stop();
      probes.clear();
      setStatus({ phase: reason === 'off' ? { kind: 'off' } : { kind: 'paused', reason } });
      if (recheckAt) recheckTimer = setTimeout(evaluate, Math.max(0, recheckAt - Date.now()) + 20);
      return;
    }
    if (micFailure) {
      setStatus({ phase: micFailure });
      return;
    }
    if (listener.active) {
      listener.configure(config());
      setStatus({ phase: audioState === 'running' ? { kind: 'running' } : { kind: 'needs-gesture' } });
      return;
    }
    setStatus({ phase: { kind: 'starting' } });
    listener.start(config()).then((ok) => {
      if (!ok || stopped) return;
      setStatus({ phase: audioState === 'running' ? { kind: 'running' } : { kind: 'needs-gesture' } });
    }).catch((f: MicFailure) => {
      if (stopped) return;
      micFailure = f?.kind ? f : { kind: 'mic-error', message: String(f) };
      setStatus({ phase: micFailure });
    });
  }

  const flash = (heard: string) => {
    clearTimeout(heardTimer);
    setStatus({ heard });
    heardTimer = setTimeout(() => setStatus({ heard: null }), HEARD_MS);
  };

  function detected(d: Omit<WakeDetection, 'at' | 'test'>) {
    const testing = useWakeStatus.getState().testing;
    const what = d.kind === 'clap' ? 'Heard two claps' : `Heard “Hey Jarvis${d.rest ? `, ${d.rest}` : ''}”`;
    if (testing) {
      setStatus({ last: { ...d, at: Date.now(), test: true } });
      flash(`${what} ✓`);
      return;
    }
    // Things may have changed while the model was thinking (the orb clicked, Jarvis talking…).
    if (!decide().run) return;
    const now = Date.now();
    if (!triggerAllowed(now, lastTriggerAt, connectedAt)) return;
    lastTriggerAt = now;
    setStatus({ last: { ...d, at: now, test: false } });
    flash(what);
    playChime();
    const st = useStore.getState();
    if (!st.voiceState.isListening) st.toggleMic();
    if (d.rest) st.sendWakeText(d.rest);
  }

  async function onSegment(seg: { id: number; kind: 'probe' | 'final'; audio: Float32Array; probed: boolean }) {
    if (!useStore.getState().wakeHeyJarvis || !asr.ready) return;
    if (seg.kind === 'probe') {
      probes.set(seg.id, asr.transcribe(seg.audio).then((r) => r.text, () => null));
      return;
    }
    const received = performance.now();
    let probeText: string | undefined;
    if (seg.probed) {
      const probe = probes.get(seg.id);
      probes.delete(seg.id);
      const text = probe ? await probe : null;
      // Not Jarvis's name at the start of the long utterance: the rest of it isn't for us.
      if (text === null || !matchWakePhrase(text)) return;
      probeText = text;
    }
    // Someone talks non-stop next to the computer: don't queue up a backlog.
    if (asr.backlog > 2) return;
    let result: { text: string; ms: number };
    try {
      result = await asr.transcribe(seg.audio);
    } catch {
      return;
    }
    if (import.meta.env.DEV) console.debug('[WAKE] heard:', result.text, `(${result.ms} ms)`);
    const match = resolveWake(probeText, result.text);
    if (!match) return;
    // The final segment goes out endSilenceMs after the last word.
    const latencyMs = Math.round(performance.now() - received + SEGMENT.endSilenceMs);
    detected({ kind: 'wake', rest: match.rest, transcript: result.text, asrMs: result.ms, latencyMs });
  }

  const unsubscribe = useStore.subscribe((s, prev) => {
    const now = Date.now();
    if (prev.voiceState.isSpeaking && !s.voiceState.isSpeaking) speakingEndedAt = now;
    if (!prev.wsConnected && s.wsConnected) connectedAt = now;
    if (!s.wsConnected) connectedAt = null;
    const prefsChanged = s.wakeHeyJarvis !== prev.wakeHeyJarvis || s.wakeClap !== prev.wakeClap || s.clapSensitivity !== prev.clapSensitivity;
    if (prefsChanged) micFailure = null; // a fresh try (the user may have allowed the mic since)
    if (
      prefsChanged ||
      s.wsConnected !== prev.wsConnected ||
      s.voiceState.isListening !== prev.voiceState.isListening ||
      s.voiceState.isSpeaking !== prev.voiceState.isSpeaking ||
      s.avatarMode !== prev.avatarMode
    ) evaluate();
  });

  // Blocked microphone: try again when the user comes back (from the system/browser settings).
  const retry = () => {
    micFailure = null;
    if (prefs().heyJarvis && useWakeStatus.getState().model.kind === 'error') asr.load();
    evaluate();
  };
  const onFocus = () => { if (micFailure) retry(); };
  window.addEventListener('focus', onFocus);
  let permission: PermissionStatus | null = null;
  navigator.permissions?.query({ name: 'microphone' as PermissionName }).then((p) => {
    if (stopped) return;
    permission = p;
    p.onchange = () => { if (p.state !== 'denied') retry(); };
  }).catch(() => {});

  testHook = () => {
    clearTimeout(testTimer);
    setStatus({ testing: true, heard: null });
    retry();
    testTimer = setTimeout(() => setStatus({ testing: false }), TEST_MS);
  };
  retryHook = retry;

  evaluate();

  stopCurrent = () => {
    stopped = true;
    unsubscribe();
    window.removeEventListener('focus', onFocus);
    if (permission) permission.onchange = null;
    clearTimeout(recheckTimer);
    clearTimeout(heardTimer);
    clearTimeout(testTimer);
    listener.dispose();
    asr.dispose();
    probes.clear();
    testHook = null;
    retryHook = null;
    stopCurrent = null;
    useWakeStatus.setState({ phase: { kind: 'off' }, model: { kind: 'idle' }, heard: null, testing: false });
  };
  return stopCurrent;
}

// Dev only: QA scripts read the standby status (window.__jarvisWake).
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __jarvisWake?: typeof useWakeStatus }).__jarvisWake = useWakeStatus;
