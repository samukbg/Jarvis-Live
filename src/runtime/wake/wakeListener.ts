// The standby microphone: its own stream (echo cancellation and noise suppression on), the
// wake AudioWorklet (claps + speech segments), and nothing else. `stop()` releases the
// microphone completely (tracks stopped) so the main capture and the live avatar's WebRTC never
// share it with standby; the AudioContext is only suspended and comes back on `start()`.
import workletUrl from './wakeProcessor.worklet.ts?worker&url';
import type { WakeProcessorConfig, WakeProcessorEvent } from './wakeProcessor.worklet';

export type MicFailure = { kind: 'mic-blocked' } | { kind: 'mic-error'; message: string };

export interface WakeListenerEvents {
  onClap: () => void;
  onSegment: (seg: Extract<WakeProcessorEvent, { type: 'segment' }>) => void;
  /** The AudioContext waits for a click/key (browser autoplay rules), or now runs. */
  onAudioState: (state: 'needs-gesture' | 'running') => void;
  /** The microphone went away (unplugged, taken by the system). */
  onEnded: () => void;
}

export class WakeListener {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private moduleLoaded: Promise<void> | null = null;
  private gen = 0;
  private cfg: WakeProcessorConfig = { clap: false, speech: false, sensitivity: 1 };
  private gestureCleanup: (() => void) | null = null;
  private readonly events: WakeListenerEvents;

  constructor(events: WakeListenerEvents) {
    this.events = events;
  }

  /** Holding the microphone now (or about to). */
  get active() {
    return this.stream !== null;
  }

  configure(cfg: WakeProcessorConfig) {
    this.cfg = cfg;
    this.node?.port.postMessage({ type: 'config', config: cfg });
  }

  /** Opens the microphone. Throws a MicFailure; resolves false when stopped meanwhile. */
  async start(cfg: WakeProcessorConfig): Promise<boolean> {
    this.cfg = cfg;
    if (this.stream) {
      this.configure(cfg);
      return true;
    }
    const gen = ++this.gen;
    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('this page can’t use the microphone (it needs https or localhost)'), { name: 'NotSupportedError' });
      stream = await navigator.mediaDevices.getUserMedia({
        // Raw: the speech filters (noise suppression, gain control, echo cancellation) smear claps
        // into a slow swell, and standby only runs while Jarvis is silent anyway.
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (e) {
      const err = e as DOMException;
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') throw { kind: 'mic-blocked' } satisfies MicFailure;
      if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') throw { kind: 'mic-error', message: 'no microphone found' } satisfies MicFailure;
      throw { kind: 'mic-error', message: err?.message || String(e) } satisfies MicFailure;
    }
    if (gen !== this.gen) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.stream = stream;
    try {
      const ctx = (this.ctx ??= new AudioContext({ latencyHint: 'playback' }));
      this.moduleLoaded ??= ctx.audioWorklet.addModule(workletUrl).catch((e) => { this.moduleLoaded = null; throw e; });
      await this.moduleLoaded;
      if (gen !== this.gen) return false;
      if (!this.node) {
        this.node = new AudioWorkletNode(ctx, 'jarvis-wake', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        this.node.port.onmessage = (e: MessageEvent<WakeProcessorEvent>) => {
          if (!this.stream) return; // stopped: late events don't count
          if (e.data.type === 'clap') this.events.onClap();
          else if (e.data.type === 'segment') this.events.onSegment(e.data);
        };
        // A silent sink keeps the node in the rendered graph (its output is zeros anyway).
        const sink = ctx.createGain();
        sink.gain.value = 0;
        this.node.connect(sink).connect(ctx.destination);
      }
      this.node.port.postMessage({ type: 'reset' });
      this.node.port.postMessage({ type: 'config', config: this.cfg });
      this.source = ctx.createMediaStreamSource(stream);
      this.source.connect(this.node);
      stream.getAudioTracks().forEach((t) => { t.onended = () => { if (this.stream === stream) this.events.onEnded(); }; });
      await this.resume(ctx, gen);
      return gen === this.gen;
    } catch (e) {
      if (gen === this.gen) this.release();
      throw { kind: 'mic-error', message: (e as Error)?.message || String(e) } satisfies MicFailure;
    }
  }

  /** Browsers start an AudioContext suspended until the page is clicked (desktop app: never). */
  private async resume(ctx: AudioContext, gen: number) {
    if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    if (gen !== this.gen) return;
    if ((ctx.state as string) === 'running') {
      this.events.onAudioState('running');
      return;
    }
    this.events.onAudioState('needs-gesture');
    this.gestureCleanup?.();
    const onGesture = () => {
      ctx.resume().then(() => {
        if (gen === this.gen && ctx.state === 'running') {
          this.gestureCleanup?.();
          this.events.onAudioState('running');
        }
      }).catch(() => {});
    };
    const opts = { capture: true } as const;
    window.addEventListener('pointerdown', onGesture, opts);
    window.addEventListener('keydown', onGesture, opts);
    this.gestureCleanup = () => {
      window.removeEventListener('pointerdown', onGesture, opts);
      window.removeEventListener('keydown', onGesture, opts);
      this.gestureCleanup = null;
    };
  }

  private release() {
    this.gestureCleanup?.();
    if (this.source) {
      try { this.source.disconnect(); } catch { /* already */ }
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      this.stream = null;
    }
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
  }

  /** Releases the microphone (the system's mic indicator goes off). */
  stop() {
    this.gen++;
    this.release();
  }

  dispose() {
    this.stop();
    this.node?.disconnect();
    this.node = null;
    this.moduleLoaded = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
