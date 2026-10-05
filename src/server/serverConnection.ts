// Which Jarvis server this app talks to — audio (WebSocket) and video (avatar WebRTC) both go
// to it: the server you run (Settings → Server: URL + API key). By default, the server that
// serves this page.

export interface ServerSettings {
  hostUrl: string;
  apiKey: string;
}

export interface ResolvedServer {
  url: string;
  /** The server's API key — sent as x-api-key / ?api_key= */
  key: string;
  name: string;
}

export class ServerUnavailableError extends Error {
  retryAfterS: number;
  /** The user has to fill something in Settings (no retry will fix it). */
  needsSetup: boolean;
  constructor(message: string, retryAfterS = 15, needsSetup = false) {
    super(message);
    this.name = 'ServerUnavailableError';
    this.retryAfterS = retryAfterS;
    this.needsSetup = needsSetup;
  }
}

const LAN = /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** "jarvis.example.com", "wss://x/ws", "http://192.168.1.5:4000/" → an http(s) base URL ('' if empty). */
export function normalizeHost(host: string): string {
  let h = (host || '').trim().replace(/\/+$/, '');
  if (!h) return '';
  let secure: boolean;
  if (/^(http|ws):\/\//i.test(h)) secure = false;
  else if (/^(https|wss):\/\//i.test(h)) secure = true;
  else secure = !LAN.test(h);
  h = h.replace(/^(https?|wss?):\/\//i, '').replace(/\/ws\/?$/i, '').replace(/\/+$/, '');
  return `${secure ? 'https' : 'http'}://${h}`;
}

/** WebSocket URL of a server base URL. */
export function wsUrlFor(httpUrl: string): string {
  return `${httpUrl.replace(/^http/i, 'ws')}/ws`;
}

/** The server to use. Throws ServerUnavailableError with a user-facing message. */
export async function resolveServer(settings: ServerSettings): Promise<ResolvedServer> {
  const url = normalizeHost(settings.hostUrl);
  if (!url) throw new ServerUnavailableError('Set your Jarvis server URL in Settings → Server.', 30, true);
  if (!settings.apiKey) throw new ServerUnavailableError('Set your Jarvis server API key in Settings → Server (API_KEY in its .env).', 30, true);
  return { url, key: settings.apiKey, name: url.replace(/^https?:\/\//, '') };
}
