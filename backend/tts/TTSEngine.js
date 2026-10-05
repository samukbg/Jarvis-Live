import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);

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
  }

  async fetchAudio(text, language) {
    const tempAudioPath = `/tmp/jarvis_speech_${Date.now()}_${Math.random().toString(36).substr(2,9)}.mp3`;
    
    let kokoroLang = 'en';
    if (language === 'pt' || language === 'por') kokoroLang = 'pt';
    if (language === 'es' || language === 'spa') kokoroLang = 'es';
    if (language === 'fr' || language === 'fra') kokoroLang = 'fr';
    if (language === 'it' || language === 'ita') kokoroLang = 'it';
    
    const requestBody = JSON.stringify({ 
      text: text, 
      language: kokoroLang
    });
    
    const ttsUrl = global.TTS_SERVER ? `${global.TTS_SERVER.replace(/\/$/, '')}/tts` : 'http://127.0.0.1:8000/tts';
    const command = `curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer kok_4xK9mP2nQ7wR5vL8jH3fN6yT1sZ0uB4cE2dA9gM7pV5iO8qW3xJ6nK1rY4tU" -d '${requestBody.replace(/'/g, "'\\''")}' "${ttsUrl}" -o "${tempAudioPath}"`;
    console.log(`[TTS] Fetching audio...`);
    await execAsync(command);
    console.log(`[TTS] Audio fetched to ${tempAudioPath}`);
    
    return tempAudioPath;
  }

  async pumpAudioFetch(activeLanguage) {
    if (this.isFetchingAudio) return;
    this.isFetchingAudio = true;
    this.onStateChange();
    while (this.speechQueue.length > 0) {
      const text = this.speechQueue.shift();
      try {
        const audioPath = await this.fetchAudio(text, activeLanguage);
        this.audioFilesQueue.push(audioPath);
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
    const audioPath = this.audioFilesQueue.shift();
  
    this.speakingInstances++;
    console.log(`[TTS] Playing audio: ${audioPath}`);
    this.onBroadcast({ type: 'voice_state', state: 'speaking' });
  
    let volumes = [];
    let pcmData = null;
    try {
      pcmData = execSync(
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
    } catch(e) {
      console.log('[TTS] Volume extraction skipped:', e.message?.slice(0, 80));
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
  
    let durationMs = 1000;
    try {
      // Use PCM length for timing if available
      if (pcmData && pcmData.length) {
        durationMs = (pcmData.length / 48000) * 1000;
      }

      // Broadcast the ORIGINAL MP3 file — much smaller than WAV PCM, natively supported
      // by iOS AVAudioPlayer/<audio> element without any transcoding. The mobile side will
      // play it via an <audio> element in the WebView (most reliable iOS path).
      const mp3Buffer = fs.readFileSync(audioPath);
      this.onBroadcast({ type: 'tts_chunk', format: 'mp3', content: mp3Buffer.toString('base64') });
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
    this.audioFilesQueue.forEach(p => { try { fs.unlinkSync(p); } catch(e){} });
    this.audioFilesQueue = [];
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    if (this.currentAfplayProc) {
      try { this.currentAfplayProc.kill('SIGKILL'); } catch(e) {}
      this.currentAfplayProc = null;
    }
    exec('pkill -9 play', () => {});
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
