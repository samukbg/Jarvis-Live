// "Sign in with Google" for Google Calendar, from any device (the phone included).
//
// Through Jarvis Cloud (computers linked to it): this server makes a PKCE pair and asks Jarvis
// Cloud for the consent link; Google sends the browser back to Jarvis Cloud, which holds the
// one-time code for this machine; this server trades it (with its verifier) through Jarvis
// Cloud, which adds the app's client secret. Jarvis Cloud never stores a token: the refresh
// token lives here only, and refreshing goes through the same relay.
//
// Self-hosted without Jarvis Cloud: GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET (a
// Google "Desktop app" OAuth client) — the browser on this computer comes back to
// http://localhost:<port>/api/calendar/google/callback.
import crypto from 'node:crypto';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];
const PENDING_MS = 10 * 60_000;
const POLL_MS = 2000;
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** The email in an id_token (not verified: it came straight from Google's token endpoint over TLS). */
export function emailOfIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
}

/**
 * `cloud()` → { url, authHeader } while this computer is linked to Jarvis Cloud, else null.
 * `onTokens(tokens, { state })` adds the account (called once per successful sign-in).
 */
export const CLOUD_REASON = 'Link this computer to Jarvis Cloud (a free account is enough) to sign in with Google — or add your Google calendar with "Subscribe by link".';
export const SELF_HOSTED_REASON = 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (a Google "Desktop app" OAuth client) in .env to sign in with Google — or add your Google calendar with "Subscribe by link".';

export function createGoogleAuth({ cloud = () => null, env = process.env, port = 4000, onTokens, fetchImpl = fetch, log = () => {}, now = Date.now, unavailableReason = CLOUD_REASON } = {}) {
  const pending = new Map(); // state → { verifier, mode, createdAt, status, account?, error? }
  const direct = () => (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET ? { id: env.GOOGLE_OAUTH_CLIENT_ID, secret: env.GOOGLE_OAUTH_CLIENT_SECRET } : null);
  const redirectUri = () => `http://localhost:${port}/api/calendar/google/callback`;

  async function cloudCall(path, body) {
    const link = cloud();
    if (!link?.authHeader) throw bad('This computer is no longer linked to Jarvis Cloud', 409);
    const r = await fetchImpl(`${link.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: link.authHeader },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }

  async function tokenRequest(params) {
    const r = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }

  function finish(state, entry, result) {
    if (result.error) {
      entry.status = 'error';
      entry.error = result.error;
      return;
    }
    Promise.resolve(onTokens(result.tokens, { state }))
      .then((account) => Object.assign(entry, { status: 'connected', account }))
      .catch((e) => Object.assign(entry, { status: 'error', error: e.message }));
  }

  // Through Jarvis Cloud: ask for the code every 2 s until the user answers Google (10 min).
  async function pollCloud(state) {
    const entry = pending.get(state);
    while (entry && entry.status === 'pending' && now() - entry.createdAt < PENDING_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const { status, data } = await cloudCall('/v1/oauth/google/exchange', { state, codeVerifier: entry.verifier });
        if (status === 202) continue;
        if (status === 200 && data.tokens?.refresh_token) return finish(state, entry, { tokens: data.tokens });
        if (status === 200) return finish(state, entry, { error: "Google didn't grant offline access — remove Jarvis from your Google account's third-party access and try again" });
        return finish(state, entry, { error: data.error || `Jarvis Cloud answered HTTP ${status}` });
      } catch (e) {
        log(`[calendar] Google sign-in poll: ${e.message}`);
      }
    }
    if (entry?.status === 'pending') Object.assign(entry, { status: 'error', error: 'Google sign-in timed out — try again' });
  }

  function sweep() {
    for (const [k, v] of pending) if (now() - v.createdAt > PENDING_MS * 2) pending.delete(k);
  }

  return {
    /** Can Google be connected here? { available, reason? } */
    available() {
      if (cloud()?.authHeader || direct()) return { available: true };
      return { available: false, reason: unavailableReason };
    },

    /** → { authUrl, state } */
    async start() {
      sweep();
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      if (cloud()?.authHeader) {
        const { status, data } = await cloudCall('/v1/oauth/google/start', { codeChallenge: challenge, scopes: GOOGLE_SCOPES });
        if (status !== 200 || !data.authUrl || !data.state) throw bad(data.error || `Jarvis Cloud couldn't start the Google sign-in (HTTP ${status})`, status === 503 ? 503 : 502);
        pending.set(data.state, { verifier, mode: 'cloud', createdAt: now(), status: 'pending' });
        pollCloud(data.state);
        return { authUrl: data.authUrl, state: data.state };
      }
      const client = direct();
      if (!client) throw bad(this.available().reason, 409);
      const state = b64url(crypto.randomBytes(18));
      pending.set(state, { verifier, mode: 'direct', createdAt: now(), status: 'pending' });
      const q = new URLSearchParams({
        client_id: client.id, redirect_uri: redirectUri(), response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      return { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, state };
    },

    /** The self-hosted flow's redirect: trades the code. → an HTML sentence for the browser. */
    async callback({ state, code, error }) {
      const entry = pending.get(String(state || ''));
      if (!entry || entry.mode !== 'direct') return { ok: false, message: 'This sign-in link expired. Start again from Jarvis Settings → Calendar.' };
      if (error || !code) {
        finish(state, entry, { error: error === 'access_denied' ? 'Google access was not granted' : `Google sign-in failed (${error || 'no code'})` });
        return { ok: false, message: 'Google Calendar was not connected.' };
      }
      const client = direct();
      const { status, data } = await tokenRequest({ client_id: client.id, client_secret: client.secret, code, code_verifier: entry.verifier, grant_type: 'authorization_code', redirect_uri: redirectUri() });
      if (status !== 200 || !data.refresh_token) {
        finish(state, entry, { error: data.error_description || data.error || `Google answered HTTP ${status}` });
        return { ok: false, message: 'Google Calendar was not connected.' };
      }
      finish(state, entry, { tokens: data });
      return { ok: true, message: 'Google Calendar is connected. You can close this tab and go back to Jarvis.' };
    },

    /** { status: 'pending' } | { status: 'connected', account } | { status: 'error', error } */
    status(state) {
      const entry = pending.get(String(state || ''));
      if (!entry) return { status: 'error', error: 'This sign-in expired — start again' };
      if (entry.status === 'pending' && now() - entry.createdAt > PENDING_MS) Object.assign(entry, { status: 'error', error: 'Google sign-in timed out — try again' });
      return entry.status === 'connected' ? { status: 'connected', account: entry.account } : entry.status === 'error' ? { status: 'error', error: entry.error } : { status: 'pending' };
    },

    /**
     * A fresh access token for a refresh token: { access_token, expires_in }. Throws with
     * code 'invalid_grant' when the user revoked it (the account then needs signing in again).
     */
    async refresh(refreshToken, via = 'cloud') {
      let res;
      if (via === 'direct' && direct()) {
        const c = direct();
        res = await tokenRequest({ client_id: c.id, client_secret: c.secret, refresh_token: refreshToken, grant_type: 'refresh_token' });
      } else {
        res = await cloudCall('/v1/oauth/google/refresh', { refreshToken });
      }
      const { status, data } = res;
      if (status === 200 && data.access_token) return data;
      const code = data.error === 'invalid_grant' || data.code === 'invalid_grant' ? 'invalid_grant' : 'refresh_failed';
      throw Object.assign(new Error(code === 'invalid_grant' ? 'Google access was removed — sign in again' : (data.error_description || data.error || `Token refresh failed (HTTP ${status})`)), { code, status: code === 'invalid_grant' ? 401 : 502 });
    },

    /** Revokes a token at Google (no client secret needed). Best effort. */
    async revoke(token) {
      if (!token) return;
      try {
        await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
      } catch { /* the account is removed here anyway */ }
    },

    modeFor: () => (cloud()?.authHeader ? 'cloud' : 'direct'),
  };
}
