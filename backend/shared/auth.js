// Who may use this Jarvis server: whoever holds its API_KEY (.env). The web app sends it as
// x-api-key, ?api_key= or the WebSocket protocol. Your own avatar server calls back with a
// short-lived callback key instead, good on its few routes only.
import crypto from 'node:crypto';

/** What the avatar server may call back on this server with a callback key. */
export const AVATAR_CALLBACK_PATHS = ['/api/avatar/delegate', '/api/avatar/transcript', '/api/agents', '/api/device/tool', '/api/device/action', '/api/business/show', '/api/cards/show',
  '/api/calendar/show', '/api/calendar/tool/calendar_agenda', '/api/calendar/tool/calendar_add_event', '/api/calendar/tool/calendar_update_event', '/api/calendar/tool/calendar_delete_event'];

const localCallbackKeys = new Map();
/** A callback key for the avatar server this server chose (instead of its API_KEY). */
export function issueLocalCallbackKey(ttlS = 4 * 3600, now = Date.now()) {
  for (const [k, exp] of localCallbackKeys) if (exp <= now) localCallbackKeys.delete(k);
  const key = `jlc.${crypto.randomBytes(24).toString('base64url')}`;
  localCallbackKeys.set(key, now + ttlS * 1000);
  return key;
}

/**
 * Did this request come from another device? Through a tunnel or proxy (Cloudflare adds
 * cf-connecting-ip; the local Vite dev server forwards without x-forwarded-for) or over the
 * network. The tunnel itself connects from localhost, so the address alone is not enough.
 */
export function isRemoteRequest(req) {
  const h = req?.headers || {};
  if (h['cf-connecting-ip'] || h['x-forwarded-for'] || h['x-real-ip']) return true;
  const addr = String(req?.socket?.remoteAddress || '');
  return !(addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

/** `path` (the request path) lets callback keys through on AVATAR_CALLBACK_PATHS only. */
export function isAuthorized(key, env = process.env, path = '') {
  if (typeof key === 'string' && key.startsWith('jlc.')) {
    const exp = localCallbackKeys.get(key);
    return !!exp && exp > Date.now() && AVATAR_CALLBACK_PATHS.includes(String(path).replace(/\/+$/, ''));
  }
  return !!key && !!env.API_KEY && key === env.API_KEY;
}

/** The key a request carries (header, query or WebSocket protocol). */
export function requestKey(req) {
  const url = req.url ? new URL(req.url, 'http://local') : null;
  return req.headers['x-api-key'] || req.query?.api_key || url?.searchParams.get('api_key') || req.headers['sec-websocket-protocol'];
}
