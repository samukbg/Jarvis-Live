import test from 'node:test';
import assert from 'node:assert/strict';
import { ClapDetector } from './clapDetector.ts';
import { matchWakePhrase } from './wakePhrase.ts';

const RATE = 16000;
// Deterministic noise so the cases are the same on every run (and in the native ports).
let seed = 1;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff * 2 - 1;
};

/** Silence with a little room noise. */
const room = (ms: number, level = 0.002) => Float32Array.from({ length: (RATE * ms) / 1000 }, () => rand() * level);
/** A palm clap: a broadband crack, ~1 ms attack, ~12 ms decay. */
const clap = (amp = 0.6) => Float32Array.from({ length: RATE * 0.12 }, (_, i) => {
  const t = i / RATE;
  return rand() * amp * Math.min(1, t / 0.001) * Math.exp(-t / 0.012);
});
/** A spoken vowel: 140 Hz with harmonics, 250 ms, soft attack. */
const vowel = (ms = 250, amp = 0.4) => Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => {
  const t = i / RATE;
  const env = Math.min(1, t / 0.03) * Math.min(1, (ms / 1000 - t) / 0.03);
  return amp * env * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.3 * Math.sin(2 * Math.PI * 700 * t));
});
/** A "t"/"k" consonant burst right before a vowel (mid-word transient). */
const syllable = () => concat(Float32Array.from({ length: RATE * 0.015 }, () => rand() * 0.3), vowel(180));
/** A door slam: loud, low, rings for a long time. */
const thud = () => Float32Array.from({ length: RATE * 0.4 }, (_, i) => {
  const t = i / RATE;
  return 0.8 * Math.exp(-t / 0.15) * (Math.sin(2 * Math.PI * 60 * t) + 0.3 * rand());
});

function concat(...parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function run(audio: Float32Array, chunk = 512) {
  const hits: number[] = [];
  const d = new ClapDetector({ sampleRate: RATE, onDoubleClap: (ms) => hits.push(ms) });
  for (let i = 0; i < audio.length; i += chunk) d.push(audio.subarray(i, i + chunk));
  return hits;
}

test('clap: two claps 300 ms apart fire once, after the second', () => {
  seed = 1;
  const hits = run(concat(room(500), clap(), room(180), clap(), room(800)));
  assert.equal(hits.length, 1);
  assert.ok(hits[0] >= 780 && hits[0] <= 840, `fired at ${hits[0]} ms`);
});

test('clap: quieter claps in a quiet room still count; any chunk size', () => {
  seed = 2;
  assert.equal(run(concat(room(500), clap(0.15), room(250), clap(0.15), room(800)), 128).length, 1);
  seed = 2;
  assert.equal(run(concat(room(500), clap(0.15), room(250), clap(0.15), room(800)), 4096).length, 1);
});

test('clap: "More" catches faint claps that "Normal" ignores', () => {
  const faint = () => concat(room(500), clap(0.03), room(250), clap(0.03), room(800));
  const runAt = (sensitivity: number) => {
    seed = 9;
    const audio = faint();
    const hits: number[] = [];
    const d = new ClapDetector({ sampleRate: RATE, sensitivity, onDoubleClap: (ms) => hits.push(ms) });
    for (let i = 0; i < audio.length; i += 512) d.push(audio.subarray(i, i + 512));
    return hits;
  };
  assert.deepEqual(runAt(1), []);
  assert.deepEqual(runAt(1.3), [870]);
});

test('clap: a single clap, claps too far apart, or applause do nothing', () => {
  seed = 3;
  assert.equal(run(concat(room(500), clap(), room(1500))).length, 0, 'single');
  seed = 4;
  assert.equal(run(concat(room(500), clap(), room(900), clap(), room(1500))).length, 0, '~1 s apart');
  seed = 5;
  assert.equal(run(concat(room(500), clap(), room(150), clap(), room(150), clap(), room(150), clap(), room(1500))).length, 0, 'applause');
});

test('clap: speech, consonant bursts and a door slam are not claps', () => {
  seed = 6;
  assert.equal(run(concat(room(300), vowel(), room(80), syllable(), room(60), syllable(), room(100), vowel(), room(800))).length, 0, 'speech');
  seed = 7;
  assert.equal(run(concat(room(300), thud(), room(200), thud(), room(800))).length, 0, 'slams');
});

test('clap: cooldown, then it works again', () => {
  seed = 8;
  const twice = concat(room(400), clap(), room(200), clap(), room(500), clap(), room(200), clap(), room(2000), clap(), room(200), clap(), room(800));
  assert.equal(run(twice).length, 2, 'the pair inside the cooldown is ignored');
});

test('wake phrase: greeting + name, the name alone, mishearings only after a greeting', () => {
  assert.deepEqual(matchWakePhrase('Hey Jarvis'), { rest: '' });
  assert.deepEqual(matchWakePhrase('Hey, Jarvis. What’s the weather tomorrow?'), { rest: 'What’s the weather tomorrow?' });
  assert.deepEqual(matchWakePhrase('jarvis open spotify'), { rest: 'open spotify' });
  assert.deepEqual(matchWakePhrase('Olá Jarvis, que horas são?'), { rest: 'que horas são?' });
  assert.deepEqual(matchWakePhrase('Hey Travis.'), { rest: '' });
  assert.equal(matchWakePhrase('Travis is late'), null);
  assert.equal(matchWakePhrase('I told Jarvis yesterday'), null);
  assert.equal(matchWakePhrase('Jarvisson'), null);
  assert.equal(matchWakePhrase(''), null);
});
