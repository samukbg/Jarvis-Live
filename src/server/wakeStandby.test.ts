import test from 'node:test';
import assert from 'node:assert/strict';
import { Resampler } from './resampler.ts';
import { SpeechSegmenter, SEGMENT, type Segment } from './speechSegmenter.ts';
import {
  AFTER_SPEECH_MS, CLAP_SENSITIVITY, maxTokensFor, resolveWake, standbyDecision, standbyHint, standbyStatusText, triggerAllowed,
  type StandbyInputs,
} from './wakeStandby.ts';
import { ClapDetector } from './clapDetector.ts';

const RATE = 16000;
let seed = 11;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
};
const room = (ms: number, level = 0.002, rate = RATE) => Float32Array.from({ length: Math.round((rate * ms) / 1000) }, () => rand() * level);
/** Voiced speech: 140 Hz + harmonics with a syllable-rate envelope. */
const speech = (ms: number, amp = 0.3, rate = RATE) => Float32Array.from({ length: Math.round((rate * ms) / 1000) }, (_, i) => {
  const t = i / rate;
  const syl = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
  return amp * syl * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.3 * Math.sin(2 * Math.PI * 1200 * t));
});
const clap = (amp = 0.6, rate = RATE) => Float32Array.from({ length: Math.round(rate * 0.12) }, (_, i) => {
  const t = i / rate;
  return rand() * amp * Math.min(1, t / 0.001) * Math.exp(-t / 0.012);
});
function concat(...parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function segments(audio: Float32Array, chunk = 128) {
  const out: Segment[] = [];
  const s = new SpeechSegmenter((seg) => out.push(seg));
  for (let i = 0; i < audio.length; i += chunk) s.push(audio.subarray(i, i + chunk));
  return out;
}

// ── Resampler ───────────────────────────────────────────────────────────────

test('resampler: 48 kHz → 16 kHz keeps the length and a 440 Hz tone, any chunk size', () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
  for (const chunk of [128, 441, 4096]) {
    const r = new Resampler(48000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < tone.length; i += chunk) parts.push(r.push(tone.subarray(i, i + chunk)).slice());
    const out = concat(...parts);
    assert.ok(Math.abs(out.length - 16000) <= 2, `length ${out.length}`);
    // Zero crossings ≈ 2 × 440 per second.
    let zc = 0;
    for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) zc++;
    assert.ok(Math.abs(zc - 880) <= 4, `zero crossings ${zc}`);
  }
});

test('resampler: 44.1 kHz → 16 kHz length; 16 kHz passes through unchanged', () => {
  const r = new Resampler(44100);
  let n = 0;
  for (let i = 0; i < 44100; i += 128) n += r.push(new Float32Array(Math.min(128, 44100 - i))).length;
  assert.ok(Math.abs(n - 16000) <= 2, `length ${n}`);
  const same = new Resampler(16000);
  const x = Float32Array.from([0.1, -0.2, 0.3]);
  assert.deepEqual(Array.from(same.push(x)), Array.from(x));
});

test('resampler + clap detector: two claps recorded at 48 kHz still fire once', () => {
  seed = 21;
  const audio48 = concat(room(500, 0.002, 48000), clap(0.6, 48000), room(250, 0.002, 48000), clap(0.6, 48000), room(800, 0.002, 48000));
  const r = new Resampler(48000);
  const hits: number[] = [];
  const d = new ClapDetector({ sampleRate: 16000, onDoubleClap: (ms) => hits.push(ms) });
  for (let i = 0; i < audio48.length; i += 128) d.push(r.push(audio48.subarray(i, i + 128)));
  assert.equal(hits.length, 1);
});

// ── Speech segmenter ────────────────────────────────────────────────────────

test('segmenter: one short utterance → one final with pre-roll, ends ~400 ms after the speech', () => {
  seed = 31;
  const segs = segments(concat(room(1000), speech(800), room(1000)));
  assert.equal(segs.length, 1);
  const [s] = segs;
  assert.equal(s.kind, 'final');
  assert.equal(s.probed, false);
  assert.ok(Math.abs(s.startMs - 1000) <= 30, `start ${s.startMs}`);
  // pre-roll 300 + speech 800 + tail ≤ 150
  const ms = (s.audio.length / RATE) * 1000;
  assert.ok(ms >= 1050 && ms <= 1300, `segment ${ms} ms`);
});

test('segmenter: quiet room, a click and a short cough give nothing', () => {
  seed = 32;
  assert.equal(segments(room(3000)).length, 0, 'room');
  seed = 33;
  assert.equal(segments(concat(room(1000), speech(120, 0.4), room(1000))).length, 0, 'short sound');
});

test('segmenter: two utterances with a pause → two segments', () => {
  seed = 34;
  const segs = segments(concat(room(800), speech(600), room(700), speech(700), room(800)));
  assert.equal(segs.length, 2);
  assert.ok(segs[0].id !== segs[1].id);
});

test('segmenter: a short pause inside a phrase (< 400 ms) keeps one segment', () => {
  seed = 35;
  const segs = segments(concat(room(800), speech(500), room(200), speech(600), room(800)));
  assert.equal(segs.length, 1);
});

test('segmenter: a long utterance → a 2.5 s probe while recording, then the whole final', () => {
  seed = 36;
  const segs = segments(concat(room(800), speech(4000), room(800)));
  assert.deepEqual(segs.map((s) => s.kind), ['probe', 'final']);
  assert.equal(segs[0].id, segs[1].id);
  assert.equal((segs[0].audio.length / RATE) * 1000, SEGMENT.probeMs);
  assert.equal(segs[1].probed, true);
  const finalMs = (segs[1].audio.length / RATE) * 1000;
  assert.ok(finalMs >= 4200 && finalMs <= 4500, `final ${finalMs} ms`);
});

test('segmenter: endless speech (TV) is capped at 10 s, then ignored until quiet', () => {
  seed = 37;
  const segs = segments(concat(room(500), speech(16000), room(800), speech(700), room(800)));
  assert.deepEqual(segs.map((s) => s.kind), ['probe', 'final', 'final']);
  assert.ok((segs[1].audio.length / RATE) * 1000 <= SEGMENT.maxMs);
});

test('segmenter: reset forgets a half-recorded segment', () => {
  seed = 38;
  const out: Segment[] = [];
  const s = new SpeechSegmenter((seg) => out.push(seg));
  s.push(concat(room(500), speech(400)));
  assert.equal(s.active, true);
  s.reset();
  s.push(room(1000));
  assert.equal(out.length, 0);
});

// ── When standby runs ───────────────────────────────────────────────────────

const base: StandbyInputs = { heyJarvis: true, clap: false, connected: true, listening: false, speaking: false, speakingEndedAt: null, avatar: false, now: 10_000 };

test('standby: runs only when on, connected, idle, quiet and no avatar call', () => {
  assert.deepEqual(standbyDecision(base), { run: true });
  assert.deepEqual(standbyDecision({ ...base, heyJarvis: false, clap: true }), { run: true });
  assert.deepEqual(standbyDecision({ ...base, heyJarvis: false }), { run: false, reason: 'off' });
  assert.deepEqual(standbyDecision({ ...base, connected: false }), { run: false, reason: 'offline' });
  assert.deepEqual(standbyDecision({ ...base, listening: true }), { run: false, reason: 'listening' });
  assert.deepEqual(standbyDecision({ ...base, speaking: true }), { run: false, reason: 'speaking' });
  assert.deepEqual(standbyDecision({ ...base, avatar: true, listening: true }), { run: false, reason: 'avatar' });
});

test('standby: waits a second after Jarvis stops talking', () => {
  const d = standbyDecision({ ...base, speakingEndedAt: 9_500 });
  assert.deepEqual(d, { run: false, reason: 'speaking', recheckAt: 9_500 + AFTER_SPEECH_MS });
  assert.deepEqual(standbyDecision({ ...base, speakingEndedAt: 10_000 - AFTER_SPEECH_MS }), { run: true });
});

test('triggers: one per 2 s, none while (re)connecting', () => {
  assert.equal(triggerAllowed(10_000, null, null), false, 'not connected');
  assert.equal(triggerAllowed(10_000, null, 9_500), false, 'just connected');
  assert.equal(triggerAllowed(10_000, null, 5_000), true);
  assert.equal(triggerAllowed(10_000, 8_500, 5_000), false, 'debounce');
  assert.equal(triggerAllowed(10_000, 8_000, 5_000), true);
});

test('status line and orb hint', () => {
  const both = { heyJarvis: true, clap: true };
  assert.equal(standbyStatusText(both, { kind: 'running' }, { kind: 'ready' }), 'Listening for “Hey Jarvis” and two claps');
  assert.equal(standbyStatusText({ heyJarvis: false, clap: true }, { kind: 'running' }, { kind: 'idle' }), 'Listening for two claps');
  assert.equal(standbyStatusText({ heyJarvis: true, clap: false }, { kind: 'running' }, { kind: 'downloading', percent: 41.6 }), 'Downloading the on-device model… 42%');
  assert.match(standbyStatusText(both, { kind: 'running' }, { kind: 'downloading', percent: 10 }), /two claps work already/);
  assert.equal(standbyStatusText(both, { kind: 'mic-blocked' }, { kind: 'ready' }), 'Microphone blocked — allow it in the browser/system settings');
  assert.equal(standbyStatusText(both, { kind: 'paused', reason: 'speaking' }, { kind: 'ready' }), 'Paused while Jarvis is talking');
  assert.equal(standbyStatusText(both, { kind: 'running' }, { kind: 'ready' }, 'Heard two claps'), 'Heard two claps');
  assert.equal(standbyStatusText({ heyJarvis: false, clap: false }, { kind: 'off' }, { kind: 'idle' }), 'Off');
  assert.equal(standbyHint(both, { kind: 'running' }, { kind: 'ready' }), 'Say “Hey Jarvis” or clap twice');
  assert.equal(standbyHint(both, { kind: 'running' }, { kind: 'downloading', percent: 3 }), 'Clap twice to talk');
  assert.equal(standbyHint(both, { kind: 'paused', reason: 'listening' }, { kind: 'ready' }), null);
});

test('wake verdict: probe decides, final gives the request', () => {
  assert.deepEqual(resolveWake(undefined, 'Hey Jarvis.'), { rest: '' });
  assert.equal(resolveWake(undefined, 'What a nice day.'), null);
  assert.deepEqual(resolveWake('Hey Jarvis, what is the weather in', 'Hey Jarvis, what is the weather in Paris?'), { rest: 'what is the weather in Paris?' });
  assert.deepEqual(resolveWake('Hey Jarvis, what is', 'A Jarvis what is the weather'), { rest: 'what is' });
  assert.equal(resolveWake('So I told him that', 'So I told him that Jarvis is great'), null);
});

test('misc: sensitivity steps and token budget', () => {
  assert.deepEqual(CLAP_SENSITIVITY, { less: 0.7, normal: 1, more: 1.3 });
  assert.ok(maxTokensFor(0.8) >= 8, 'short audio still gets tokens');
  assert.equal(maxTokensFor(100), 96);
});
