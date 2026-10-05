import { WebSocket } from 'ws';

export class STTProxy {
  constructor(options) {
    this.sttSocket = null;
    this.micActive = true;
    
    // Callbacks
    this.onWakeWord = options.onWakeWord || (() => {});
    this.onPartial = options.onPartial || (() => {});
    this.onFinal = options.onFinal || (() => {});
    this.onLog = options.onLog || (() => {});
    this.onNotification = options.onNotification || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.isTtsSpeaking = options.isTtsSpeaking || (() => false);
  }

  setMicActive(active) {
    this.micActive = active;
    if (this.sttSocket?.readyState === WebSocket.OPEN) {
      this.sttSocket.send(JSON.stringify({ type: active ? 'full_mode' : 'wake_only' }));
    }
  }
  
  setLanguage(language) {
    if (this.sttSocket?.readyState === WebSocket.OPEN) {
      this.sttSocket.send(JSON.stringify({ type: 'set_language', language }));
    }
  }

  send(data) {
    if (this.sttSocket?.readyState === WebSocket.OPEN) {
      this.sttSocket.send(JSON.stringify(data));
    }
  }

  getSocket() {
    return this.sttSocket;
  }

  // RealtimeSTT is optional (a Jarvis Server on a user's computer usually has none): after a
  // failed attempt, retry less and less often (5 s → 60 s) and say so only once.
  connect() {
    const url = process.env.STT_URL || 'ws://localhost:8001';
    this.failures ??= 0;
    if (this.failures === 0) this.onLog(`🔄 Connecting to RealtimeSTT (${url})...`);
    const retry = () => setTimeout(() => this.connect(), Math.min(5000 * 2 ** this.failures++, 60_000));
    try {
      this.sttSocket = new WebSocket(url);

      this.sttSocket.on('open', () => {
        this.failures = 0;
        this.onLog('✅ Connected to RealtimeSTT');
        this.onNotification({ label: 'STT ENGINE', msg: 'RealtimeSTT online (tiny.en)', kind: 'success' });
      });

      this.sttSocket.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'stt_partial' || msg.type === 'stt_final' || msg.type === 'stt_wake') {
            console.log(`[STT IN] type=${msg.type} text="${msg.text}"`);
          }

          if (this.isTtsSpeaking()) {
            if (msg.type === 'stt_final' && msg.text?.trim()) {
              console.log(`[STT] Echo suppressed: "${msg.text.trim()}"`);
            }
            return;
          }

          if (msg.type === 'stt_wake') {
            this.onWakeWord();
          }

          if (msg.type === 'stt_partial' && msg.text?.trim()) {
            this.onPartial(msg.text);
          }

          if (msg.type === 'stt_final' && msg.text?.trim()) {
            this.onFinal(msg.text.trim());
          }
        } catch(e) {}
      });

      this.sttSocket.on('error', (err) => {
        if (this.failures === 0) console.error('❌ STT Connection Error:', err.message || err.code || 'unreachable');
      });

      this.sttSocket.on('close', () => {
        if (this.failures === 0) console.warn('⚠️ RealtimeSTT unavailable — retrying in the background');
        retry();
      });
    } catch(e) {
      retry();
    }
  }
}
