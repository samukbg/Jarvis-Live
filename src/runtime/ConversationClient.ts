// ConversationClient.ts
// A modern abstraction for interacting with the backend ConversationRuntime WebSocket.

type MessageCallback = (msg: any) => void;

export class ConversationClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: MessageCallback;
  private onConnect: () => void;
  private onDisconnect: () => void;

  constructor(url: string, onMessage: MessageCallback, onConnect: () => void, onDisconnect: () => void) {
    this.url = url;
    this.onMessage = onMessage;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.onConnect();
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          this.onMessage(msg);
        } catch (e) {
          console.error('[ConversationClient] Failed to parse message', e);
        }
      } else {
        // Binary audio stream
        this.onMessage({ type: 'audio_stream', data: event.data });
      }
    };

    this.ws.onclose = () => {
      this.onDisconnect();
      setTimeout(() => this.connect(), 3000);
    };
  }

  send(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendBinary(data: ArrayBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  toggleMic(active: boolean) {
    this.send({ type: 'mic_toggle', active });
  }

  setModel(model: string) {
    this.send({ type: 'set_model', model });
  }

  setLanguage(language: string) {
    this.send({ type: 'set_language', language });
  }

  setGeminiLiveMode(enabled: boolean) {
    this.send({ type: 'set_gemini_live_mode', enabled });
  }

  sendCommand(text: string, model: string) {
    this.send({ type: 'command', text, model });
  }
}
