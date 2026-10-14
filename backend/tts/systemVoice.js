// Jarvis's voice when no TTS server answers: the computer's own voice (macOS `say`, Windows
// System.Speech, Linux espeak-ng) written to a WAV file. A Jarvis Server on a user's computer
// has no TTS server (the old default was a Kokoro server on 127.0.0.1:8000), so without this
// every answer with Gemini Live off stayed silent.
import { spawn, execFile } from 'node:child_process';

const TWO_LETTER = { eng: 'en', por: 'pt', spa: 'es', fra: 'fr', fre: 'fr', ita: 'it', deu: 'de', ger: 'de', jpn: 'ja', zho: 'zh', chi: 'zh', nld: 'nl', dut: 'nl', rus: 'ru' };

/** 'eng' / 'pt-BR' / 'fr_FR' → 'en' / 'pt' / 'fr'. */
export function languageCode(language) {
  const raw = String(language || 'en').toLowerCase().split(/[-_]/)[0];
  return TWO_LETTER[raw] || (raw.length === 2 ? raw : 'en');
}

// Jarvis speaks with a woman's voice by default; Settings → Voice lets the owner pick another.
// macOS doesn't say which voices are female, so they're known by name (Siri-quality "(Premium)"
// / "(Enhanced)" downloads share the base name).
const MAC_FEMALE = new Set([
  'Samantha', 'Ava', 'Allison', 'Susan', 'Victoria', 'Zoe', 'Nicky', 'Karen', 'Moira', 'Tessa', 'Tara',
  'Serena', 'Kate', 'Fiona', 'Veena', 'Flo', 'Grandma', 'Sandy', 'Shelley', 'Joana', 'Catarina', 'Luciana',
  'Fernanda', 'Amélie', 'Audrey', 'Aurélie', 'Marie', 'Mónica', 'Monica', 'Paulina', 'Marisol', 'Angélica',
  'Isabela', 'Alice', 'Federica', 'Paola', 'Anna', 'Petra', 'Helena', 'Ellen', 'Claire', 'Kyoko', 'O-Ren',
  'Tingting', 'Ting-Ting', 'Meijia', 'Mei-Jia', 'Sinji', 'Sin-ji', 'Yuna', 'Milena', 'Katya', 'Zuzana',
  'Ioana', 'Laura', 'Sara', 'Nora', 'Klara', 'Alva', 'Satu', 'Mariska', 'Melina', 'Carmit', 'Lekha', 'Lana',
  'Tünde', 'Damayanti', 'Amira', 'Kanya', 'Linh', 'Yelda', 'Lesya', 'Montse', 'Soledad',
]);
const MAC_MALE = new Set([
  'Daniel', 'Alex', 'Tom', 'Aaron', 'Arthur', 'Gordon', 'Lee', 'Oliver', 'Evan', 'Nathan', 'Aman', 'Rishi',
  'Eddy', 'Grandpa', 'Reed', 'Rocko', 'Thomas', 'Nicolas', 'Jacques', 'Jorge', 'Juan', 'Diego', 'Carlos',
  'Luca', 'Xander', 'Yannick', 'Markus', 'Martin', 'Majed', 'Maged', 'Yuri', 'Felipe',
]);
// Sound effects and joke voices: never offered.
const MAC_NOVELTY = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester', 'Organ',
  'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Fred', 'Junior', 'Ralph', 'Kathy',
]);
// The first of these that's installed speaks the language unless the owner picked a voice.
const PREFERRED = {
  en: ['Ava (Premium)', 'Ava (Enhanced)', 'Samantha (Enhanced)', 'Samantha', 'Ava'],
  pt: ['Joana (Enhanced)', 'Joana', 'Luciana (Enhanced)', 'Luciana'],
  fr: ['Amélie (Enhanced)', 'Amélie', 'Audrey', 'Aurélie'],
  es: ['Mónica (Enhanced)', 'Mónica', 'Monica', 'Paulina'],
  it: ['Alice (Enhanced)', 'Alice', 'Federica'],
  de: ['Anna (Enhanced)', 'Anna', 'Petra'],
};
// espeak-ng voice variants (Linux): female first.
const ESPEAK_VARIANTS = [
  { id: 'f3', name: 'Female 1', gender: 'female' }, { id: 'f2', name: 'Female 2', gender: 'female' },
  { id: 'f4', name: 'Female 3', gender: 'female' }, { id: 'm3', name: 'Male 1', gender: 'male' },
  { id: 'm1', name: 'Male 2', gender: 'male' },
];

const baseName = (name) => name.replace(/\s*\(.*\)\s*$/, '');

/**
 * The computer's real voices from `say -v ?` output ("Name   xx_YY   # sample"):
 * [{ id, name, locale, language, gender }] — gender 'female' / 'male' when known, else null.
 */
export function parseMacVoices(sayVoicesOutput) {
  return String(sayVoicesOutput || '').split('\n')
    .map((line) => line.match(/^(.+?)\s+([a-z]{2,3})_([A-Za-z0-9]{2,4})\s+#/))
    .filter(Boolean)
    .map((m) => ({ name: m[1].trim(), language: m[2], locale: `${m[2]}-${m[3]}` }))
    .filter((v) => !MAC_NOVELTY.has(baseName(v.name)))
    .map((v) => ({ id: v.name, ...v, gender: MAC_FEMALE.has(baseName(v.name)) ? 'female' : MAC_MALE.has(baseName(v.name)) ? 'male' : null }));
}

/** Windows voices from "Name|Culture|Gender" lines (System.Speech). */
export function parseWindowsVoices(output) {
  return String(output || '').split(/\r?\n/)
    .map((line) => line.trim().split('|'))
    .filter((p) => p.length === 3 && p[0])
    .map(([name, culture, gender]) => ({
      id: name, name: name.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, ''), locale: culture,
      language: culture.split('-')[0].toLowerCase(), gender: /female/i.test(gender) ? 'female' : /male/i.test(gender) ? 'male' : null,
    }));
}

/**
 * The voice that speaks `language`: the owner's choice when it speaks that language, else a
 * woman's voice of the language (the preferred names, then Premium/Enhanced, plain names, and
 * the "Eddy (French (France))" variants last). Null when none is installed.
 */
export function pickVoice(voices, language, chosen = null) {
  const lang = languageCode(language);
  const own = (voices || []).filter((v) => v.language === lang);
  if (chosen) {
    const match = own.find((v) => v.id === chosen);
    if (match) return match;
  }
  for (const name of PREFERRED[lang] || []) {
    const v = own.find((x) => x.id === name);
    if (v) return v;
  }
  const rank = (v) => (v.gender === 'female' ? 0 : 3) + (/\((Premium|Enhanced)\)/.test(v.name) ? 0 : /\(/.test(v.name) ? 2 : 1);
  return [...own].sort((a, b) => rank(a) - rank(b))[0] || null;
}

/** The macOS voice name for the language (kept for callers that have `say -v ?` output). */
export function pickMacVoice(sayVoicesOutput, language, chosen = null) {
  return pickVoice(parseMacVoices(sayVoicesOutput), language, chosen)?.id || null;
}

const WINDOWS_SCRIPT = [
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$all = $s.GetInstalledVoices() | Where-Object { $_.Enabled }',
  // The owner's voice when it speaks the language, else a woman's voice of the language.
  '$v = $all | Where-Object { $_.VoiceInfo.Name -eq $env:JARVIS_TTS_VOICE -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $env:JARVIS_TTS_LANG } | Select-Object -First 1',
  'if (-not $v) { $v = $all | Where-Object { $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $env:JARVIS_TTS_LANG } | Sort-Object { if ($_.VoiceInfo.Gender -eq \'Female\') { 0 } else { 1 } } | Select-Object -First 1 }',
  'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
  '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
  '$s.SetOutputToWaveFile($env:JARVIS_TTS_OUT, $f)',
  '$s.Speak([Console]::In.ReadToEnd())',
  '$s.Dispose()',
].join('; ');

/**
 * How to write `text` as speech to `outFile` (WAV) on this platform: { cmd, args, env }.
 * The text always goes on stdin — never through a shell or as an argument.
 */
export function systemVoiceCommand({ platform = process.platform, outFile, language, macVoice = null, voice = null }) {
  const lang = languageCode(language);
  if (platform === 'darwin') {
    return { cmd: 'say', args: ['--file-format=WAVE', '--data-format=LEI16@24000', ...(macVoice ? ['-v', macVoice] : []), '-o', outFile, '-f', '-'] };
  }
  if (platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], env: { JARVIS_TTS_OUT: outFile, JARVIS_TTS_LANG: lang, JARVIS_TTS_VOICE: voice || '' } };
  }
  const variant = ESPEAK_VARIANTS.some((v) => v.id === voice) ? voice : ESPEAK_VARIANTS[0].id;
  return { cmd: 'espeak-ng', args: ['-v', `${lang}+${variant}`, '-w', outFile, '--stdin'] };
}

/**
 * Header facts and the 16-bit samples of a PCM WAV file (walks the RIFF chunks: macOS `say`
 * puts a FLLR chunk before the data). Null when it isn't a PCM WAV.
 */
export function parseWav(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = { audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === 'data' && fmt) {
      const end = Math.min(buf.length, body + size);
      return { ...fmt, data: buf.subarray(body, end) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Playback length (ms) and loudness per 50 ms window (0–1, for the orb) of a WAV file. */
export function wavTiming(buf, windowMs = 50) {
  const wav = parseWav(buf);
  if (!wav || wav.audioFormat !== 1 || wav.bitsPerSample !== 16 || !wav.sampleRate || !wav.channels) return null;
  const frameBytes = 2 * wav.channels;
  const frames = Math.floor(wav.data.length / frameBytes);
  const perWindow = Math.max(1, Math.round((wav.sampleRate * windowMs) / 1000));
  const volumes = [];
  for (let start = 0; start < frames; start += perWindow) {
    const end = Math.min(frames, start + perWindow);
    let sumSq = 0;
    for (let f = start; f < end; f++) {
      const s = wav.data.readInt16LE(f * frameBytes) / 32768;
      sumSq += s * s;
    }
    volumes.push(Math.min(1, Math.sqrt(sumSq / (end - start)) * 4));
  }
  return { durationMs: (frames / wav.sampleRate) * 1000, volumes };
}

let voiceList = null;
/**
 * The voices this computer can speak with: [{ id, name, locale, language, gender }].
 * Cached: the list only changes when the owner downloads a voice (restart picks it up).
 */
export function listSystemVoices({ platform = process.platform, execFileImpl = execFile } = {}) {
  if (voiceList) return voiceList;
  const run = (cmd, args) => new Promise((resolve) => {
    execFileImpl(cmd, args, { timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
  if (platform === 'darwin') voiceList = run('say', ['-v', '?']).then(parseMacVoices);
  else if (platform === 'win32') {
    voiceList = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name + '|' + $_.VoiceInfo.Gender }"])
      .then(parseWindowsVoices);
  } else voiceList = Promise.resolve(null); // espeak-ng: variants, any language (see voicesFor)
  return voiceList;
}

/** Test hook: forget the cached list. */
export function resetVoiceListCache() { voiceList = null; }

// The owner's choices, one voice per language: "en=Moira;pt=Joana (Enhanced)" (TTS_SYSTEM_VOICE).
// A bare name (the first format) is a choice for whichever language that voice speaks.

/** "en=Moira;pt=Joana" → { en: 'Moira', pt: 'Joana' }; a bare name → { '*': name }. */
export function parseVoiceChoices(value) {
  const choices = {};
  for (const part of String(value || '').split(';')) {
    const m = part.match(/^\s*([a-z]{2,3})\s*=\s*(.+?)\s*$/);
    if (m) choices[m[1]] = m[2];
    else if (part.trim()) choices['*'] = part.trim();
  }
  return choices;
}

/** { en: 'Moira', pt: 'Joana' } → "en=Moira;pt=Joana" (empty choices dropped). */
export function formatVoiceChoices(choices) {
  return Object.entries(choices || {}).filter(([k, v]) => k !== '*' && v).map(([k, v]) => `${k}=${v}`).join(';');
}

/** The voice chosen for a language, if any. */
export function choiceFor(choices, language) {
  return choices?.[languageCode(language)] || choices?.['*'] || null;
}

const languageName = (code) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
};

/**
 * Every language this computer can speak, the one Jarvis speaks now first, then by name:
 * [{ language, label, current, chosen, voices }] — voices female first; current = the voice that
 * reads that language (the owner's choice — chosen — else the default woman's voice).
 */
export async function voiceCatalog(activeLanguage, choices = {}, { platform = process.platform, execFileImpl } = {}) {
  const active = languageCode(activeLanguage);
  if (platform !== 'darwin' && platform !== 'win32') {
    const chosen = choiceFor(choices, active);
    const valid = ESPEAK_VARIANTS.some((v) => v.id === chosen);
    return [{
      language: active, label: languageName(active), current: valid ? chosen : ESPEAK_VARIANTS[0].id, chosen: valid,
      voices: ESPEAK_VARIANTS.map((v) => ({ ...v, language: active, locale: active })),
    }];
  }
  const all = (await listSystemVoices({ platform, execFileImpl })) || [];
  const rank = (v) => (v.gender === 'female' ? 0 : 1);
  return [...new Set(all.map((v) => v.language))]
    .map((language) => {
      const choice = choiceFor(choices, language);
      const current = pickVoice(all, language, choice)?.id || null;
      return {
        language, label: languageName(language), current, chosen: !!choice && current === choice,
        voices: all.filter((v) => v.language === language).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => (b.language === active) - (a.language === active) || a.label.localeCompare(b.label));
}

/** Speak `text` into `outFile` (WAV) with the computer's own voice. Rejects when it can't. */
export async function synthesizeWithSystemVoice(text, language, outFile, { platform = process.platform, spawnImpl = spawn, timeoutMs = 30_000, voice: setting = process.env.TTS_SYSTEM_VOICE || null, execFileImpl } = {}) {
  // `voice`: one voice name, or the per-language choices ("en=Moira;pt=Joana").
  const voice = choiceFor(parseVoiceChoices(setting), language);
  const macVoice = platform === 'darwin' ? pickVoice(await listSystemVoices({ platform, execFileImpl }), language, voice)?.id || null : null;
  const { cmd, args, env } = systemVoiceCommand({ platform, outFile, language, macVoice, voice });
  await new Promise((resolve, reject) => {
    const proc = spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    let stderr = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    proc.stderr?.on('data', (d) => { stderr += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
    });
    proc.stdin?.on('error', () => {});
    proc.stdin?.end(text);
  });
  return outFile;
}
