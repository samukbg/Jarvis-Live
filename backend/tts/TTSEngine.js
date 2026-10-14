import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { synthesizeWithSystemVoice, wavTiming } from './systemVoice.js';


export class TTSEngine {
  constructor(options) {
    this.speechQueue = [];
    this.audioFilesQueue = [];
    this.isFetchingAudio = false;
    this.isPlayingAudio = false;
    this.currentAfplayProc = null;
    this.speakingInstances = 0;
    this.lastSpeechEndTime = 0;
    
    // Callbacks provided by the orchestrator
    this.onStateChange = options.onStateChange || (() => {});
    this.onBroadcast = options.onBroadcast || (() => {});
    // Injectable for tests.
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
    this.synthesizeSystemVoice = options.synthesizeSystemVoice || synthesizeWithSystemVoice;
    this.ttsServerDownUntil = 0;
  }

  /**
   * The speech for one sentence as a file: { path, format }. From the TTS server when one
   * answers (Settings → TTS server, TTS_SERVER), else the computer's own voice (WAV).
   */
  async fetchAudio(text, language) {
    const base = path.join(os.tmpdir(), `jarvis_speech_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`);
    const ttsUrl = this.ttsServerUrl();
    if (ttsUrl && Date.now() >= this.ttsServerDownUntil) {
      try {
        return await this.fetchFromTtsServer(ttsUrl, text, language, base);
      } catch (e) {
        // Unreachable (no TTS server on this computer, the usual case): don't ask again for a minute.
        this.ttsServerDownUntil = Date.now() + 60_000;
        if (!this.loggedTtsServerDown) console.log(`[TTS] No TTS server at ${ttsUrl} (${e.message}) — using this computer's voice`);
        this.loggedTtsServerDown = true;
      }
    }
    console.log('[TTS] Speaking with this computer\'s voice...');
    const wavPath = await this.synthesizeSystemVoice(text, language, `${base}.wav`);
    return { path: wavPath, format: 'wav' };
  }

  ttsServerUrl() {
    const server = global.TTS_SERVER;
    return server ? `${String(server).replace(/\/$/, '')}/tts` : null;
  }

  async fetchFromTtsServer(ttsUrl, text, language, base) {
    let kokoroLang = 'en';
    if (language === 'pt' || language === 'por') kokoroLang = 'pt';
    if (language === 'es' || language === 'spa') kokoroLang = 'es';
    if (language === 'fr' || language === 'fra') kokoroLang = 'fr';
    if (language === 'it' || language === 'ita') kokoroLang = 'it';

    console.log(`[TTS] Fetching audio...`);
    const res = await this.fetchImpl(ttsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer kok_4xK9mP2nQ7wR5vL8jH3fN6yT1sZ0uB4cE2dA9gM7pV5iO8qW3xJ6nK1rY4tU' },
      body: JSON.stringify({ text, language: kokoroLang }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '');
    if (/json|text|html/i.test(type)) throw new Error(`not audio (${type})`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('empty audio');
    const format = /wav/i.test(type) || audio.toString('ascii', 0, 4) === 'RIFF' ? 'wav' : 'mp3';
    const audioPath = `${base}.${format}`;
    fs.writeFileSync(audioPath, audio);
    console.log(`[TTS] Audio fetched to ${audioPath}`);
    this.ttsServerDownUntil = 0;
    this.loggedTtsServerDown = false;
    return { path: audioPath, format };
  }

  async pumpAudioFetch(activeLanguage) {
    if (this.isFetchingAudio) return;
    this.isFetchingAudio = true;
    this.onStateChange();
    while (this.speechQueue.length > 0) {
      const text = this.speechQueue.shift();
      try {
        const audio = await this.fetchAudio(text, activeLanguage);
        this.audioFilesQueue.push(audio);
        this.pumpAudioPlay();
      } catch(e) {
        console.error('[TTS] Fetch error:', e.message);
      }
    }
    this.isFetchingAudio = false;
    this.onStateChange();
    if (!this.isPlayingAudio && this.audioFilesQueue.length === 0) {
      this.pumpAudioPlay();
    }
  }

  async pumpAudioPlay() {
    if (this.isPlayingAudio) return;
    if (this.audioFilesQueue.length === 0) {
      this.onStateChange();
      return;
    }
    
    this.isPlayingAudio = true;
    this.onStateChange();
    const { path: audioPath, format } = this.audioFilesQueue.shift();
  
    this.speakingInstances++;
    console.log(`[TTS] Playing audio: ${audioPath}`);
    this.onBroadcast({ type: 'voice_state', state: 'speaking' });
  
    let volumes = [];
    let durationMs = 1000;
    if (format === 'wav') {
      // WAV (the computer's voice): length and loudness straight from the samples, no sox needed.
      try {
        const timing = wavTiming(fs.readFileSync(audioPath));
        if (timing) ({ durationMs, volumes } = timing);
      } catch (e) {}
    } else {
      try {
        const pcmData = execSync(
          `sox "${audioPath}" -t raw -r 24000 -b 16 -c 1 -e signed-integer -`,
          { maxBuffer: 50 * 1024 * 1024 }
        );
        const samplesPerChunk = 1200;
        const bytesPerChunk = samplesPerChunk * 2;
        for (let i = 0; i < pcmData.length; i += bytesPerChunk) {
          const end = Math.min(i + bytesPerChunk, pcmData.length);
          let sumSq = 0;
          let count = 0;
          for (let j = i; j < end - 1; j += 2) {
            const sample = pcmData.readInt16LE(j) / 32768.0;
            sumSq += sample * sample;
            count++;
          }
          const rms = Math.sqrt(sumSq / Math.max(1, count));
          volumes.push(Math.min(1.0, rms * 4.0));
        }
        // Use PCM length for timing if available
        if (pcmData.length) durationMs = (pcmData.length / 48000) * 1000;
      } catch(e) {
        console.log('[TTS] Volume extraction skipped:', e.message?.slice(0, 80));
      }
    }
  
    let volIdx = 0;
    let volInterval = null;
    if (volumes.length > 0) {
      volInterval = setInterval(() => {
        if (volIdx >= volumes.length) {
          clearInterval(volInterval);
          volInterval = null;
          return;
        }
        this.onBroadcast({ type: 'tts_volume', level: volumes[volIdx] });
        volIdx++;
      }, 50);
    }
  
    try {
      // The file as it is (MP3 from a TTS server, WAV from the computer's voice): every client
      // plays both (<audio>, AVAudioPlayer) without transcoding.
      const audioBuffer = fs.readFileSync(audioPath);
      this.onBroadcast({ type: 'tts_chunk', format, content: audioBuffer.toString('base64') });
    } catch (e) {
      console.log('[TTS] Failed to read audio or broadcast', e.message);
    }

    await new Promise((resolve) => {
      this.currentTimeout = setTimeout(() => {
        this.currentTimeout = null;
        try { fs.unlinkSync(audioPath); } catch (e) {}
        if (volInterval) { clearInterval(volInterval); volInterval = null; }
        this.speakingInstances = Math.max(0, this.speakingInstances - 1);
        if (this.speakingInstances === 0) {
          this.lastSpeechEndTime = Date.now();
        }
        console.log(`[TTS] Audio finished (simulated). speakingInstances=${this.speakingInstances}`);
        this.isPlayingAudio = false;
        if (this.speakingInstances === 0 && this.audioFilesQueue.length === 0 && this.speechQueue.length === 0) {
          this.onBroadcast({ type: 'voice_state', state: 'idle' });
        }
        this.onStateChange();
        resolve();
      }, durationMs);
    });
    
    this.pumpAudioPlay();
  }

  stopSpeaking() {
    this.speechQueue = [];
    this.audioFilesQueue.forEach(a => { try { fs.unlinkSync(a.path); } catch(e){} });
    this.audioFilesQueue = [];
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    if (this.currentAfplayProc) {
      try { this.currentAfplayProc.kill('SIGKILL'); } catch(e) {}
      this.currentAfplayProc = null;
    }
    if (this.speakingInstances > 0) {
      this.speakingInstances = 0;
      this.lastSpeechEndTime = Date.now();
    }
    this.isPlayingAudio = false;
    this.onBroadcast({ type: 'voice_state', state: 'idle' });
    this.onBroadcast({ type: 'gemini_live_interrupt' }); // tell frontend to clear queue
    this.onStateChange();
  }

  speak(speechText, activeLanguage, geminiLiveMode, activeModel, options = { interrupt: true }) {
    if (!speechText) return;
    if (geminiLiveMode && !options.force) {
      console.log(`[TTS] Suppressed (Gemini Live active): "${speechText.slice(0, 60)}"`);
      return;
    }
  
    if (options.interrupt) {
      this.stopSpeaking();
    }
  
    console.log(`[TTS] Queued sentence: "${speechText.substring(0, 60)}"`);
    this.speechQueue.push(speechText);
    this.pumpAudioFetch(activeLanguage);
  }
}
