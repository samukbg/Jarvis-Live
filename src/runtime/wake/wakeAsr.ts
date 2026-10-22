// The main thread's side of the "Hey Jarvis" model worker: load it once (with progress), then
// transcribe short segments one at a time. The worker (and the model, ~50 MB download) only exists while
// "Hey Jarvis" is on.
import type { AsrRequest, AsrResponse } from './wakeAsr.worker';
import type { ModelState } from '../../server/wakeStandby';

/** ONNX Runtime's WebAssembly files, served by Jarvis itself (vite.config.ts → onnxRuntimeFiles). */
const ORT_BASE: string = import.meta.env.VITE_ORT_BASE || 'ort/';

export class WakeAsr {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: { text: string; ms: number }) => void; reject: (e: Error) => void }>();
  private readonly onModel: (s: ModelState) => void;
  state: ModelState = { kind: 'idle' };

  constructor(onModel: (s: ModelState) => void) {
    this.onModel = onModel;
  }

  private setState(s: ModelState) {
    this.state = s;
    this.onModel(s);
  }

  /** Starts loading (downloads the first time). Safe to call again; retries after an error. */
  load() {
    if (this.worker && this.state.kind !== 'error') return;
    this.dispose();
    const w = new Worker(new URL('./wakeAsr.worker.ts', import.meta.url), { type: 'module', name: 'jarvis-wake-asr' });
    this.worker = w;
    w.onmessage = (e: MessageEvent<AsrResponse>) => {
      if (this.worker !== w) return;
      const m = e.data;
      switch (m.type) {
        case 'progress': this.setState({ kind: 'downloading', percent: m.percent }); break;
        case 'preparing': this.setState({ kind: 'preparing' }); break;
        case 'ready': this.setState({ kind: 'ready' }); console.info(`[WAKE] on-device model ready in ${m.ms} ms`); break;
        case 'error': this.setState({ kind: 'error', message: friendly(m.message) }); console.warn('[WAKE] model failed to load:', m.message); break;
        case 'result': this.pending.get(m.id)?.resolve({ text: m.text, ms: m.ms }); this.pending.delete(m.id); break;
        case 'failed': this.pending.get(m.id)?.reject(new Error(m.message)); this.pending.delete(m.id); break;
      }
    };
    w.onerror = (e) => {
      if (this.worker !== w) return;
      this.setState({ kind: 'error', message: friendly(e.message || 'the model worker stopped') });
    };
    const abs = (f: string) => new URL(`${import.meta.env.BASE_URL}${ORT_BASE}${f}`, window.location.href).href;
    this.setState({ kind: 'downloading', percent: 0 });
    w.postMessage({ type: 'load', wasmPaths: { mjs: abs('ort-wasm-simd-threaded.mjs'), wasm: abs('ort-wasm-simd-threaded.wasm') } } satisfies AsrRequest);
  }

  get ready() {
    return this.state.kind === 'ready';
  }

  /** The words in a 16 kHz segment (the audio buffer is handed over to the worker). */
  transcribe(audio: Float32Array): Promise<{ text: string; ms: number }> {
    if (!this.worker || !this.ready) return Promise.reject(new Error('model not ready'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'transcribe', id, audio } satisfies AsrRequest, [audio.buffer]);
    });
  }

  /** How many segments wait for the model. */
  get backlog() {
    return this.pending.size;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('stopped'));
    this.pending.clear();
    if (this.state.kind !== 'idle') this.setState({ kind: 'idle' });
  }
}

const friendly = (message: string) =>
  /fetch|network|load failed|404|403/i.test(message) ? 'couldn’t download it — check the internet connection' : 'couldn’t start it on this device';
