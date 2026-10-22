// The standby listener's AudioWorklet: microphone audio → 16 kHz → the double-clap detector and
// the speech segmenter. Only events leave the audio thread: a double clap, or a short speech
// segment for the on-device "Hey Jarvis" model. Nothing is recorded or sent anywhere else.
// Loaded with `?worker&url` (bundled on its own, imports included).
import { ClapDetector } from '../../server/clapDetector.ts';
import { Resampler } from '../../server/resampler.ts';
import { SpeechSegmenter } from '../../server/speechSegmenter.ts';

// AudioWorkletGlobalScope (not in TypeScript's DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessor): void;

export interface WakeProcessorConfig {
  clap: boolean;
  speech: boolean;
  /** ClapDetector sensitivity (0.7 / 1 / 1.3). */
  sensitivity: number;
}

export type WakeProcessorEvent =
  | { type: 'clap'; at: number }
  | { type: 'segment'; id: number; kind: 'probe' | 'final'; audio: Float32Array; probed: boolean; at: number; speechEndMs: number };

class WakeProcessor extends AudioWorkletProcessor {
  private cfg: WakeProcessorConfig = { clap: false, speech: false, sensitivity: 1 };
  private readonly resampler = new Resampler(sampleRate, 16000);
  private clap: ClapDetector = this.newClapDetector();
  private readonly segmenter = new SpeechSegmenter((s) => {
    if (!this.cfg.speech) return;
    const msg: WakeProcessorEvent = { type: 'segment', id: s.id, kind: s.kind, audio: s.audio, probed: s.probed, at: currentTime, speechEndMs: s.endMs };
    this.port.postMessage(msg, [s.audio.buffer]);
  });

  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === 'config') {
        const sensitivityChanged = m.config.sensitivity !== this.cfg.sensitivity;
        this.cfg = m.config;
        if (sensitivityChanged) this.clap = this.newClapDetector();
      } else if (m?.type === 'reset') {
        this.resampler.reset();
        this.clap.reset();
        this.segmenter.reset();
      }
    };
  }

  private newClapDetector() {
    return new ClapDetector({
      sampleRate: 16000,
      sensitivity: this.cfg?.sensitivity ?? 1,
      onDoubleClap: () => {
        if (this.cfg.clap) this.port.postMessage({ type: 'clap', at: currentTime } satisfies WakeProcessorEvent);
      },
    });
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch || (!this.cfg.clap && !this.cfg.speech)) return true;
    const s16 = this.resampler.push(ch);
    if (this.cfg.clap) this.clap.push(s16);
    if (this.cfg.speech) this.segmenter.push(s16);
    return true;
  }
}

registerProcessor('jarvis-wake', WakeProcessor);
