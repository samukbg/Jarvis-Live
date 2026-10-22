// The on-device "Hey Jarvis" recognizer: Moonshine tiny (MIT) through transformers.js in this
// worker, on ONNX Runtime's WebAssembly backend served by Jarvis itself. It only ever hears
// the short speech segments the standby listener cuts (≤ 10 s), and only on this device. The
// model's files come from Hugging Face once, then from the browser's cache.
import { env, pipeline } from '@huggingface/transformers';
import { maxTokensFor } from '../../server/wakeStandby.ts';

const WAKE_MODEL = 'onnx-community/moonshine-tiny-ONNX';
/** Pinned: the files (and the browser cache) never change under us. */
const WAKE_MODEL_REVISION = 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95';

export type AsrRequest =
  | { type: 'load'; wasmPaths: { mjs: string; wasm: string } }
  | { type: 'transcribe'; id: number; audio: Float32Array };

export type AsrResponse =
  | { type: 'progress'; percent: number }
  | { type: 'preparing' }
  | { type: 'ready'; ms: number }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; text: string; ms: number }
  | { type: 'failed'; id: number; message: string };

type Transcriber = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<Transcriber> | null = null;
const post = (m: AsrResponse) => (self as unknown as Worker).postMessage(m);

async function load(wasmPaths: { mjs: string; wasm: string }): Promise<Transcriber> {
  const started = performance.now();
  env.allowLocalModels = false;
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = wasmPaths;
    // Threads need cross-origin isolation (SharedArrayBuffer); one thread is plenty for ~2 s of audio.
    onnx.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ? 2 : 1;
  }
  let lastPercent = -1;
  let prepared = false;
  const fn = await pipeline('automatic-speech-recognition', WAKE_MODEL, {
    revision: WAKE_MODEL_REVISION,
    device: 'wasm',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    progress_callback: (p: { status: string; progress?: number }) => {
      if (p.status === 'progress_total' && typeof p.progress === 'number') {
        // Files start one after another (the total grows): never go backwards.
        const percent = Math.max(lastPercent, Math.min(99, p.progress));
        if (Math.floor(percent) !== Math.floor(lastPercent)) post({ type: 'progress', percent });
        lastPercent = percent;
      } else if (p.status === 'done' && !prepared && lastPercent >= 99) {
        prepared = true;
        post({ type: 'preparing' });
      }
    },
  });
  const transcriber = fn as unknown as Transcriber;
  // Warm up (compiles the WebAssembly, allocates): the first real "Hey Jarvis" is then fast.
  await transcriber(new Float32Array(16000), { max_new_tokens: 4 });
  post({ type: 'ready', ms: Math.round(performance.now() - started) });
  return transcriber;
}

self.onmessage = async (e: MessageEvent<AsrRequest>) => {
  const m = e.data;
  if (m.type === 'load') {
    if (!asr) {
      asr = load(m.wasmPaths);
      asr.catch((err) => {
        asr = null;
        post({ type: 'error', message: String((err as Error)?.message || err).slice(0, 200) });
      });
    }
    return;
  }
  if (m.type === 'transcribe') {
    try {
      if (!asr) throw new Error('model not loaded');
      const run = await asr;
      const t0 = performance.now();
      const out = await run(m.audio, { max_new_tokens: maxTokensFor(m.audio.length / 16000) });
      const text = (Array.isArray(out) ? out[0]?.text : out?.text) || '';
      post({ type: 'result', id: m.id, text: text.trim(), ms: Math.round(performance.now() - t0) });
    } catch (err) {
      post({ type: 'failed', id: m.id, message: String((err as Error)?.message || err) });
    }
  }
};
