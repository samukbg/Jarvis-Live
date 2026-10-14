import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { languageCode, pickMacVoice, pickVoice, parseMacVoices, parseWindowsVoices, voiceCatalog, parseVoiceChoices, formatVoiceChoices, choiceFor, resetVoiceListCache, systemVoiceCommand, parseWav, wavTiming, synthesizeWithSystemVoice } from './systemVoice.js';

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

const SAY = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Daniel              en_GB    # Hello! My name is Daniel.',
  'Karen               en_AU    # Hello! My name is Karen.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Reed (English (US)) en_US    # Hello! My name is Reed.',
  'Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.',
  'Eddy (French (France)) fr_FR    # Bonjour, je m’appelle Eddy.',
  'Thomas              fr_FR    # Bonjour, je m’appelle Thomas.',
  'Luciana             pt_BR    # Olá, o meu nome é Luciana.',
  'Joana (Enhanced)    pt_PT    # Olá, chamo-me Joana.',
].join('\n');

test('parseMacVoices: real voices with their language; female when known; no joke voices', () => {
  const voices = parseMacVoices(SAY);
  assert.ok(!voices.some((v) => v.name === 'Albert'));
  assert.deepEqual(voices.find((v) => v.id === 'Samantha'), { id: 'Samantha', name: 'Samantha', language: 'en', locale: 'en-US', gender: 'female' });
  assert.equal(voices.find((v) => v.id === 'Daniel').gender, 'male');
  assert.equal(voices.find((v) => v.id === 'Joana (Enhanced)').gender, 'female');
});

test('pickMacVoice / pickVoice: a woman’s voice by default; the owner’s choice when it speaks the language', () => {
  assert.equal(pickMacVoice(SAY, 'en'), 'Samantha');
  assert.equal(pickMacVoice(SAY, 'fr'), 'Amélie');
  assert.equal(pickMacVoice(SAY, 'por'), 'Joana (Enhanced)');
  assert.equal(pickMacVoice(SAY, 'de'), null);
  assert.equal(pickMacVoice(SAY, 'en', 'Daniel'), 'Daniel');
  // Daniel can't speak French: French keeps its own voice.
  assert.equal(pickMacVoice(SAY, 'fr', 'Daniel'), 'Amélie');
  assert.equal(pickMacVoice(SAY, 'en', 'Nobody'), 'Samantha');
  // No preferred name installed: female before the others, plain names before variants.
  const v = parseMacVoices(['Reed (English (US)) en_US    # x', 'Daniel              en_GB    # x', 'Karen               en_AU    # x'].join('\n'));
  assert.equal(pickVoice(v, 'en').id, 'Karen');
});

test('parseWindowsVoices: name, culture and gender from System.Speech', () => {
  const v = parseWindowsVoices('Microsoft David Desktop|en-US|Male\r\nMicrosoft Zira Desktop|en-US|Female\r\n');
  assert.deepEqual(v[1], { id: 'Microsoft Zira Desktop', name: 'Zira', locale: 'en-US', language: 'en', gender: 'female' });
  assert.equal(pickVoice(v, 'en').id, 'Microsoft Zira Desktop');
});

test('voice choices: one per language, stored as "en=Moira;pt=Joana"', () => {
  const c = parseVoiceChoices('en=Moira;pt=Joana (Enhanced)');
  assert.deepEqual(c, { en: 'Moira', pt: 'Joana (Enhanced)' });
  assert.equal(formatVoiceChoices({ ...c, fr: '' }), 'en=Moira;pt=Joana (Enhanced)');
  assert.equal(choiceFor(c, 'por'), 'Joana (Enhanced)');
  assert.equal(choiceFor(c, 'fr'), null);
  assert.equal(choiceFor(parseVoiceChoices('Daniel'), 'en'), 'Daniel'); // a bare name: any language it speaks
});

test('voiceCatalog: every language, the spoken one first; voices female first; the voice in use', async () => {
  resetVoiceListCache();
  const execFileImpl = (cmd, args, opts, cb) => cb(null, SAY);
  const cat = await voiceCatalog('pt', { en: 'Daniel' }, { platform: 'darwin', execFileImpl });
  assert.deepEqual(cat.map((g) => g.label), ['Portuguese', 'English', 'French']);
  assert.equal(cat[0].current, 'Joana (Enhanced)');
  const en = cat.find((g) => g.language === 'en');
  assert.deepEqual(en.voices.map((v) => v.id), ['Karen', 'Samantha', 'Daniel', 'Reed (English (US))']);
  assert.equal(en.current, 'Daniel');
  assert.equal(en.chosen, true);
  assert.equal(cat[0].chosen, false);
  assert.equal((await voiceCatalog('en', {}, { platform: 'darwin', execFileImpl }))[0].current, 'Samantha');
  const linux = await voiceCatalog('pt', { pt: 'm1' }, { platform: 'linux' });
  assert.equal(linux.length, 1);
  assert.equal(linux[0].current, 'm1');
  resetVoiceListCache();
});

test('systemVoiceCommand: text never on the command line', () => {
  const mac = systemVoiceCommand({ platform: 'darwin', outFile: '/tmp/a.wav', language: 'fr', macVoice: 'Thomas' });
  assert.equal(mac.cmd, 'say');
  assert.deepEqual(mac.args, ['--file-format=WAVE', '--data-format=LEI16@24000', '-v', 'Thomas', '-o', '/tmp/a.wav', '-f', '-']);
  const win = systemVoiceCommand({ platform: 'win32', outFile: 'C:\\t\\a.wav', language: 'pt', voice: 'Microsoft Maria Desktop' });
  assert.equal(win.cmd, 'powershell.exe');
  assert.deepEqual(win.env, { JARVIS_TTS_OUT: 'C:\\t\\a.wav', JARVIS_TTS_LANG: 'pt', JARVIS_TTS_VOICE: 'Microsoft Maria Desktop' });
  const linux = systemVoiceCommand({ platform: 'linux', outFile: '/tmp/a.wav', language: 'eng' });
  assert.deepEqual([linux.cmd, ...linux.args], ['espeak-ng', '-v', 'en+f3', '-w', '/tmp/a.wav', '--stdin']);
  assert.deepEqual(systemVoiceCommand({ platform: 'linux', outFile: '/tmp/a.wav', language: 'en', voice: 'm1' }).args.slice(0, 2), ['-v', 'en+m1']);
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
  assert.deepEqual(calls[0], { cmd: 'espeak-ng', args: ['-v', 'en+f3', '-w', '/tmp/x.wav', '--stdin'], text: '-four, sir' });
  await assert.rejects(synthesizeWithSystemVoice('hi', 'en', '/tmp/x.wav', { platform: 'linux', spawnImpl: fakeSpawn(1) }), /exited with 1/);
});

test('synthesizeWithSystemVoice on macOS: Samantha by default, the chosen voice of each language', async () => {
  resetVoiceListCache();
  const calls = [];
  const spawnImpl = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { on() {}, end() { calls.push(args); setImmediate(() => proc.emit('close', 0)); } };
    return proc;
  };
  const execFileImpl = (cmd, args, opts, cb) => cb(null, SAY);
  await synthesizeWithSystemVoice('Hello', 'en', '/tmp/x.wav', { platform: 'darwin', spawnImpl, execFileImpl, voice: null });
  await synthesizeWithSystemVoice('Hello', 'en', '/tmp/x.wav', { platform: 'darwin', spawnImpl, execFileImpl, voice: 'Daniel' });
  await synthesizeWithSystemVoice('Olá', 'pt', '/tmp/x.wav', { platform: 'darwin', spawnImpl, execFileImpl, voice: 'en=Daniel;pt=Luciana' });
  await synthesizeWithSystemVoice('Bonjour', 'fr', '/tmp/x.wav', { platform: 'darwin', spawnImpl, execFileImpl, voice: 'en=Daniel;pt=Luciana' });
  assert.deepEqual(calls.map((a) => a[a.indexOf('-v') + 1]), ['Samantha', 'Daniel', 'Luciana', 'Amélie']);
  resetVoiceListCache();
});
