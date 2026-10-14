import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { languageCode, pickMacVoice, systemVoiceCommand, parseWav, wavTiming, synthesizeWithSystemVoice } from './systemVoice.js';

/** A 16-bit mono PCM WAV; `extraChunk` goes before the data, like macOS `say`'s FLLR chunk. */
function wav(samples, { sampleRate = 24000, extraChunk = true } = {}) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const fllr = Buffer.alloc(extraChunk ? 8 + 10 : 0);
  if (extraChunk) { fllr.write('FLLR', 0, 'ascii'); fllr.writeUInt32LE(10, 4); }
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0, 'ascii'); dataHdr.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, fllr, dataHdr, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

test('languageCode: app codes and locales → two letters', () => {
  assert.equal(languageCode('eng'), 'en');
  assert.equal(languageCode('por'), 'pt');
  assert.equal(languageCode('pt-BR'), 'pt');
  assert.equal(languageCode('fr_FR'), 'fr');
  assert.equal(languageCode(undefined), 'en');
});

test('pickMacVoice: system voice for English, a real voice of the language otherwise', () => {
  const out = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.',
    'Eddy (French (France)) fr_FR    # Bonjour, je m’appelle Eddy.',
    'Thomas              fr_FR    # Bonjour, je m’appelle Thomas.',
    'Luciana             pt_BR    # Olá, o meu nome é Luciana.',
    'Joana (Enhanced)    pt_PT    # Olá, chamo-me Joana.',
  ].join('\n');
  assert.equal(pickMacVoice(out, 'en'), null);
  assert.equal(pickMacVoice(out, 'fr'), 'Amélie');
  assert.equal(pickMacVoice(out, 'por'), 'Joana (Enhanced)');
  assert.equal(pickMacVoice(out, 'de'), null);
});

test('systemVoiceCommand: text never on the command line', () => {
  const mac = systemVoiceCommand({ platform: 'darwin', outFile: '/tmp/a.wav', language: 'fr', macVoice: 'Thomas' });
  assert.equal(mac.cmd, 'say');
  assert.deepEqual(mac.args, ['--file-format=WAVE', '--data-format=LEI16@24000', '-v', 'Thomas', '-o', '/tmp/a.wav', '-f', '-']);
  const win = systemVoiceCommand({ platform: 'win32', outFile: 'C:\\t\\a.wav', language: 'pt' });
  assert.equal(win.cmd, 'powershell.exe');
  assert.deepEqual(win.env, { JARVIS_TTS_OUT: 'C:\\t\\a.wav', JARVIS_TTS_LANG: 'pt' });
  const linux = systemVoiceCommand({ platform: 'linux', outFile: '/tmp/a.wav', language: 'eng' });
  assert.deepEqual([linux.cmd, ...linux.args], ['espeak-ng', '-v', 'en', '-w', '/tmp/a.wav', '--stdin']);
});

test('parseWav / wavTiming: walks past extra chunks; duration and loudness from the samples', () => {
  const samples = [...Array(1200).fill(0), ...Array(1200).fill(16384)]; // 50 ms silence, 50 ms loud
  const buf = wav(samples);
  const parsed = parseWav(buf);
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.data.length, samples.length * 2);
  const t = wavTiming(buf);
  assert.equal(Math.round(t.durationMs), 100);
  assert.equal(t.volumes.length, 2);
  assert.equal(t.volumes[0], 0);
  assert.equal(t.volumes[1], 1); // 0.5 RMS × 4, capped at 1
  assert.equal(parseWav(Buffer.from('ID3 not a wav at all')), null);
  assert.equal(wavTiming(Buffer.from('nope')), null);
});

test('synthesizeWithSystemVoice: text on stdin; a failing voice rejects', async () => {
  const calls = [];
  const fakeSpawn = (code) => (cmd, args) => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { on() {}, end(text) { calls.push({ cmd, args, text }); setImmediate(() => proc.emit('close', code)); } };
    return proc;
  };
  await synthesizeWithSystemVoice('-four, sir', 'en', '/tmp/x.wav', { platform: 'linux', spawnImpl: fakeSpawn(0) });
  assert.deepEqual(calls[0], { cmd: 'espeak-ng', args: ['-v', 'en', '-w', '/tmp/x.wav', '--stdin'], text: '-four, sir' });
  await assert.rejects(synthesizeWithSystemVoice('hi', 'en', '/tmp/x.wav', { platform: 'linux', spawnImpl: fakeSpawn(1) }), /exited with 1/);
});
