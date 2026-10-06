// Where this server's live avatar runs: its default streamer (STREAMER_URL / this computer), or your own AVTR-1
// server — a streamer (http://<gpu-pc>:7860) or another Jarvis server with a GPU. Chosen in
// Settings → Live avatar, saved in the data folder. Either way the avatar calls THIS computer
// back for its agents.
import fs from 'node:fs';
import os from 'node:os';

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^.]+\.local$|[^.]+$)/i;
const LOOPBACK = /^(localhost|127\.)/i;
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/** { mode, url, key } from Settings → a clean source; throws on bad input. */
export function normalizeSource(input = {}) {
  const mode = input.mode;
  if (mode === 'cloud') return { mode, url: '', key: '' };
  if (mode !== 'own') throw new Error('mode must be "cloud" or "own"');
  let url = String(input.url || '').trim().replace(/\/+$/, '').replace(/\/api\/avatar$/i, '');
  if (url && !/^[a-z]+:\/\//i.test(url)) url = `${PRIVATE.test(url.split(/[:/]/)[0]) ? 'http' : 'https'}://${url}`;
  if (!/^https?:\/\/[^/\s]+/i.test(url)) throw new Error('Enter your avatar server URL, e.g. http://192.168.1.20:7860');
  return { mode, url, key: String(input.key || '').trim().slice(0, 300) };
}

export function createAvatarSource({ file }) {
  let current = { mode: 'cloud', url: '', key: '' };
  try { current = normalizeSource(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* default */ }
  return {
    get: () => ({ ...current }),
    set(input) {
      current = normalizeSource(input);
      fs.writeFileSync(file, JSON.stringify(current, null, 2), { mode: 0o600 });
      return { ...current };
    },
  };
}

/** This computer's private IPv4 on the local network (not loopback / VPN), or null. */
export function lanAddress(ifaces = os.networkInterfaces()) {
  const all = Object.values(ifaces).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  return (all.find((i) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) || null)?.address ?? null;
}

/** Where an avatar on `target` reaches this computer's agents. */
export function callbackUrl({ target, port, lan, tunnelUrl, envUrl }) {
  if (envUrl) return envUrl.replace(/\/+$/, '');
  const host = hostOf(target);
  if (LOOPBACK.test(host)) return `http://127.0.0.1:${port}`;
  const direct = lan ? `http://${lan}:${port}` : null;
  if (PRIVATE.test(host)) return direct || tunnelUrl || null;
  return tunnelUrl || direct;
}
