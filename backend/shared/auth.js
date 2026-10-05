// Who may use this Jarvis server: whoever holds its API_KEY (.env). The web app sends it as
// x-api-key, ?api_key= or the WebSocket protocol.

export function isAuthorized(key, env = process.env) {
  return !!key && !!env.API_KEY && key === env.API_KEY;
}

/** The key a request carries (header, query or WebSocket protocol). */
export function requestKey(req) {
  const url = req.url ? new URL(req.url, 'http://local') : null;
  return req.headers['x-api-key'] || req.query?.api_key || url?.searchParams.get('api_key') || req.headers['sec-websocket-protocol'];
}
