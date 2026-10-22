// /api/calendar/* — Settings → Calendar, the agenda card and the live avatar's calendar tools.
// Contract: calendar/API.md.
//
// Who: calendars are the user's private life, so only this computer's owner and the owner's apps
// (Jarvis Cloud 'app' tokens) may read or change them. The live avatar on a Cloud GPU ('avatar'
// callback token) may only call the voice tools: POST /api/calendar/tool/<name> and /show
// (shared/auth.js AVATAR_CALLBACK_PATHS). Private / LAN addresses (a Nextcloud at home, a local feed) only for
// the owner's key.
import { ORIGINS } from './service.js';
import { isRemoteRequest } from '../shared/auth.js';

const FORBIDDEN = { error: "Only this computer's owner can do this" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * `role(req)` → 'owner' | 'app' | 'avatar' | 'cloud' | null (shared/auth.js authorize);
 * `avatarOrigin()` → the device that started the live avatar (its cards go there).
 */
export function registerCalendarRoutes(app, { service, role, avatarOrigin = () => undefined }) {
  const manages = (req) => ['owner', 'app'].includes(role(req));
  const originOf = (req) => (ORIGINS.includes(req.body?.origin) ? req.body.origin : undefined);
  const fail = (res, e) => res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: e.message || 'Calendar error' });
  const guard = (handler) => async (req, res) => {
    if (!manages(req)) return res.status(403).json(FORBIDDEN);
    try {
      await handler(req, res);
    } catch (e) {
      fail(res, e);
    }
  };

  app.get('/api/calendar', guard((req, res) => res.json(service.overview())));

  app.post('/api/calendar/accounts', guard(async (req, res) => {
    const account = await service.addAccount(req.body || {}, { allowPrivate: role(req) === 'owner' });
    res.status(201).json({ account });
  }));

  app.patch('/api/calendar/accounts/:id', guard(async (req, res) => {
    res.json({ account: await service.updateAccount(req.params.id, req.body || {}) });
  }));

  app.post('/api/calendar/accounts/:id/sync', guard(async (req, res) => {
    res.json({ account: await service.syncAccount(req.params.id) });
  }));

  app.delete('/api/calendar/accounts/:id', guard(async (req, res) => {
    if (!(await service.removeAccount(req.params.id))) return res.status(404).json({ error: 'No such calendar account' });
    res.json({ ok: true });
  }));

  app.put('/api/calendar/settings', guard((req, res) => res.json({ settings: service.setSettings(req.body || {}) })));

  app.post('/api/calendar/google/start', guard(async (req, res) => res.json(await service.googleStart())));
  app.get('/api/calendar/google/status', guard((req, res) => res.json(service.googleStatus(String(req.query.state || '')))));

  // Self-hosted Google sign-in (googleAuth.js direct mode): the browser comes back here. The
  // one-time state proves it; no key on this request.
  app.get('/api/calendar/google/callback', async (req, res) => {
    const out = await service.googleCallback({ state: req.query.state, code: req.query.code, error: req.query.error }).catch((e) => ({ ok: false, message: e.message }));
    res.status(out.ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jarvis · Google Calendar</title><body style="font:16px system-ui;background:#0b0d12;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0"><p style="max-width:28em;text-align:center">${esc(out.message)}</p></body>`);
  });

  app.get('/api/calendar/events', guard(async (req, res) => {
    res.json(await service.events({ from: req.query.from ? String(req.query.from) : undefined, to: req.query.to ? String(req.query.to) : undefined, q: req.query.q ? String(req.query.q) : undefined }));
  }));

  app.post('/api/calendar/events', guard(async (req, res) => {
    const { event } = await service.createEvent(req.body || {});
    res.status(201).json({ event });
  }));

  app.patch('/api/calendar/events', guard(async (req, res) => {
    const { event } = await service.updateEvent(req.body || {});
    res.json({ event });
  }));

  app.delete('/api/calendar/events', guard(async (req, res) => {
    const b = { ...(req.query || {}), ...(req.body || {}) };
    await service.deleteEvent({ accountId: b.accountId, calendarId: b.calendarId, eventId: b.eventId });
    res.json({ ok: true });
  }));

  app.post('/api/calendar/device/sync', guard((req, res) => res.json({ account: service.deviceSync(req.body || {}) })));

  // The agenda card. `result` is what the voice model says.
  app.post('/api/calendar/show', async (req, res) => {
    const who = role(req);
    if (!['owner', 'app', 'avatar'].includes(who)) return res.status(403).json(FORBIDDEN);
    const b = req.body || {};
    const origin = who === 'avatar' || b.via === 'avatar' ? avatarOrigin() : originOf(req);
    try {
      const { result } = await service.show({ range: b.range, day: b.day, from: b.from, to: b.to, q: b.q, origin });
      res.json({ ok: true, result });
    } catch (e) {
      fail(res, e);
    }
  });

  // The agent CLIs (non-Live mode): the calendar tools with the short-lived token agentBrief()
  // put in their prompt — from this computer only (the server's key isn't in any prompt).
  app.post('/api/calendar/agent/:name', async (req, res) => {
    if (isRemoteRequest(req) || !service.agentTokenOk(req.headers['x-calendar-token'])) return res.status(403).json(FORBIDDEN);
    if (!service.isTool(req.params.name)) return res.status(404).json({ error: 'Unknown calendar tool' });
    const { via, ...args } = req.body || {};
    res.type('text/plain').send(await service.runTool(req.params.name, args));
  });

  // The live avatar's calendar tools (GET /api/device/tool lists each with its own path —
  // CALENDAR_TOOL_PATHS): the tool's arguments → { result } for Gemini to speak from.
  app.post('/api/calendar/tool/:name', async (req, res) => {
    const who = role(req);
    if (!['owner', 'app', 'avatar'].includes(who)) return res.status(403).json(FORBIDDEN);
    if (!service.isTool(req.params.name)) return res.status(404).json({ error: 'Unknown calendar tool' });
    const { via, ...args } = req.body || {};
    const origin = who === 'avatar' || via === 'avatar' ? avatarOrigin() : originOf(req);
    res.json({ result: await service.runTool(req.params.name, args, { origin }) });
  });
}
