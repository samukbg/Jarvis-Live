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

/**
 * A macOS voice for the language, from `say -v ?` output ("Name   xx_YY   # sample").
 * English uses the system's own voice (null). Prefers Premium/Enhanced voices, then the
 * plain-named ones (Thomas, Luciana…) over the novelty variants (Eddy (French (France))…).
 */
export function pickMacVoice(sayVoicesOutput, language) {
  const lang = languageCode(language);
  if (lang === 'en') return null;
  const voices = String(sayVoicesOutput || '').split('\n')
    .map((line) => line.match(/^(.+?)\s+([a-z]{2,3})_[A-Za-z0-9]{2,4}\s+#/))
    .filter((m) => m && m[2] === lang)
    .map((m) => m[1].trim());
  const rank = (name) => (/\((Premium|Enhanced)\)/.test(name) ? 0 : /\(/.test(name) ? 2 : 1);
  return voices.sort((a, b) => rank(a) - rank(b))[0] || null;
}

const WINDOWS_SCRIPT = [
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $env:JARVIS_TTS_LANG } | Select-Object -First 1',
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
export function systemVoiceCommand({ platform = process.platform, outFile, language, macVoice = null }) {
  const lang = languageCode(language);
  if (platform === 'darwin') {
    return { cmd: 'say', args: ['--file-format=WAVE', '--data-format=LEI16@24000', ...(macVoice ? ['-v', macVoice] : []), '-o', outFile, '-f', '-'] };
  }
  if (platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], env: { JARVIS_TTS_OUT: outFile, JARVIS_TTS_LANG: lang } };
  }
  return { cmd: 'espeak-ng', args: ['-v', lang, '-w', outFile, '--stdin'] };
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

let macVoices = null;
function macVoiceList() {
  if (macVoices) return macVoices;
  macVoices = new Promise((resolve) => {
    execFile('say', ['-v', '?'], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
  return macVoices;
}

/** Speak `text` into `outFile` (WAV) with the computer's own voice. Rejects when it can't. */
export async function synthesizeWithSystemVoice(text, language, outFile, { platform = process.platform, spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  const macVoice = platform === 'darwin' ? pickMacVoice(await macVoiceList(), language) : null;
  const { cmd, args, env } = systemVoiceCommand({ platform, outFile, language, macVoice });
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
