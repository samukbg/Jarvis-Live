import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TTSEngine } from './TTSEngine.js';

/** 100 ms of a 16-bit mono 24 kHz tone as a WAV file. */
function toneWav() {
  const data = Buffer.alloc(2400 * 2);
  for (let i = 0; i < 2400; i++) data.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function engine({ fetchImpl }) {
  const sent = [];
  const synthesized = [];
  const tts = new TTSEngine({
    onBroadcast: (m) => sent.push(m),
    fetchImpl,
    synthesizeSystemVoice: async (text, language, outFile) => {
      synthesized.push({ text, language });
      fs.writeFileSync(outFile, toneWav());
      return outFile;
    },
  });
  return { tts, sent, synthesized };
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('no TTS server on this computer: the answer is spoken with the computer\'s voice (WAV)', async () => {
  global.TTS_SERVER = 'http://127.0.0.1:8000';
  let asked = 0;
  const { tts, sent, synthesized } = engine({ fetchImpl: async () => { asked++; throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); } });
  tts.speak('That would be four, sir.', 'en', false, 'gemini');
  await until(() => sent.some((m) => m.type === 'tts_chunk'));
  const chunk = sent.find((m) => m.type === 'tts_chunk');
  assert.equal(chunk.format, 'wav');
  assert.equal(Buffer.from(chunk.content, 'base64').toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(synthesized, [{ text: 'That would be four, sir.', language: 'en' }]);
  await until(() => sent.some((m) => m.type === 'tts_volume' && m.level > 0)); // the orb gets the voice level
  await until(() => sent.some((m) => m.type === 'voice_state' && m.state === 'idle') && !tts.isPlayingAudio);

  // The unreachable server isn't asked again for every sentence.
  tts.speak('Anything else?', 'en', false, 'gemini');
  await until(() => synthesized.length === 2);
  assert.equal(asked, 1);
  tts.stopSpeaking();
});

test('a TTS server that answers is still used (MP3 passes through)', async () => {
  global.TTS_SERVER = 'http://tts.local';
  const mp3 = Buffer.from('ID3fake-mp3-bytes');
  const { tts, sent, synthesized } = engine({
    fetchImpl: async (url) => {
      assert.equal(url, 'http://tts.local/tts');
      return new Response(mp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  tts.speak('Hello.', 'en', false, 'gemini');
  await until(() => sent.some((m) => m.type === 'tts_chunk'));
  const chunk = sent.find((m) => m.type === 'tts_chunk');
  assert.equal(chunk.format, 'mp3');
  assert.deepEqual(Buffer.from(chunk.content, 'base64'), mp3);
  assert.equal(synthesized.length, 0);
  tts.stopSpeaking();
});

test('a TTS server error page is not played as audio', async () => {
  global.TTS_SERVER = 'http://tts.local';
  const { tts, sent, synthesized } = engine({
    fetchImpl: async () => new Response('{"error":"bad"}', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  tts.speak('Hello.', 'en', false, 'gemini');
  await until(() => sent.some((m) => m.type === 'tts_chunk'));
  assert.equal(sent.find((m) => m.type === 'tts_chunk').format, 'wav');
  assert.equal(synthesized.length, 1);
  tts.stopSpeaking();
});

test('Gemini Live on: nothing is spoken by the server', async () => {
  const { tts, sent } = engine({ fetchImpl: async () => { throw new Error('unused'); } });
  tts.speak('Hello.', 'en', true, 'gemini');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.filter((m) => m.type === 'tts_chunk').length, 0);
});
