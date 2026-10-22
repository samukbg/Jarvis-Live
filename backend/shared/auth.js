// Who may use this Jarvis server: whoever holds its API_KEY (.env). The web app sends it as
// x-api-key, ?api_key= or the WebSocket protocol.

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

export function isAuthorized(key, env = process.env) {
  return !!key && !!env.API_KEY && key === env.API_KEY;
}

/** The key a request carries (header, query or WebSocket protocol). */
export function requestKey(req) {
  const url = req.url ? new URL(req.url, 'http://local') : null;
  return req.headers['x-api-key'] || req.query?.api_key || url?.searchParams.get('api_key') || req.headers['sec-websocket-protocol'];
}
