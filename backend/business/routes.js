// /api/business/* — Settings → Businesses and the Business Dashboard card.
//
// Who: the sources and their overviews describe the user's own work, so only this computer's
// owner and the owner's apps (Jarvis Cloud 'app' tokens — the phone edits sources too, like
// /api/avatar/source) may read or change them. The live avatar on a Cloud GPU ('avatar'
// callback token) may only open the card: POST /api/business/show (shared/auth.js
// AVATAR_CALLBACK_PATHS). A Cloud session token on a GPU server ('cloud') gets nothing here.
// Loopback / LAN links (a local API) only when the owner's key adds them (scanWebsite.js).
import { ORIGINS } from './service.js';

const FORBIDDEN = { error: "Only this computer's owner can do this" };

/**
 * `role(req)` → 'owner' | 'app' | 'avatar' | 'cloud' | null (shared/auth.js authorize);
 * `avatarOrigin()` → the device that started the live avatar (its card goes there).
 */
export function registerBusinessRoutes(app, { service, role, avatarOrigin = () => undefined }) {
  const manages = (req) => ['owner', 'app'].includes(role(req));
  const originOf = (req) => (ORIGINS.includes(req.body?.origin) ? req.body.origin : undefined);

  app.get('/api/business/sources', (req, res) => {
    if (!manages(req)) return res.status(403).json(FORBIDDEN);
    res.json({ sources: service.sources() });
  });

  app.post('/api/business/sources', async (req, res) => {
    if (!manages(req)) return res.status(403).json(FORBIDDEN);
    const b = req.body || {};
    try {
      const source = await service.add({
        kind: b.kind,
        target: b.target,
        name: b.name,
        headers: b.headers,
        origin: originOf(req),
        announce: b.announce,
        allowPrivate: role(req) === 'owner',
      });
      res.status(201).json({ source }); // public view: header names, never values
    } catch (e) {
      if (e.code === 'duplicate') return res.status(409).json({ error: e.message, source: e.source ? { id: e.source.id, name: e.source.name, status: e.source.status } : undefined });
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.post('/api/business/sources/:id/refresh', (req, res) => {
    if (!manages(req)) return res.status(403).json(FORBIDDEN);
    const source = service.refresh(req.params.id, { origin: originOf(req), announce: req.body?.announce });
    if (!source) return res.status(404).json({ error: 'No such source' });
    res.json({ source });
  });

  app.delete('/api/business/sources/:id', (req, res) => {
    if (!manages(req)) return res.status(403).json(FORBIDDEN);
    if (!service.remove(req.params.id)) return res.status(404).json({ error: 'No such source' });
    res.json({ ok: true });
  });

  app.get('/api/business/dashboard', (req, res) => {
    if (!manages(req)) return res.status(403).json(FORBIDDEN);
    res.json(service.dashboard({ focus: req.query.focus ? String(req.query.focus) : undefined }));
  });

  // Opens the card on the apps. `result` is what the voice model says (the live avatar's
  // show_business_dashboard tool posts its arguments here: { name?, via: 'avatar' }).
  app.post('/api/business/show', (req, res) => {
    const who = role(req);
    if (!['owner', 'app', 'avatar'].includes(who)) return res.status(403).json(FORBIDDEN);
    const b = req.body || {};
    const origin = who === 'avatar' || b.via === 'avatar' ? avatarOrigin() : originOf(req);
    const { spoken } = service.show({ focus: b.focus || b.name || undefined, origin });
    res.json({ ok: true, result: spoken });
  });
}
