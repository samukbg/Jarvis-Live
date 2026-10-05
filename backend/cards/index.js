// POST /api/cards/enrich — real data behind the rich result cards.
// Each enricher returns { data, prefer, sources, refreshMs } or null; the client
// merges `data` into what the agent stated (`prefer` says which side wins).
import { enrichWeather } from './weather.js';
import { enrichFinance } from './finance.js';
import { enrichSystem } from './system.js';
import { enrichMedia, spotifyControl } from './media.js';
import { enrichWallet } from './wallet.js';
import { enrichFlight } from './flight.js';
import { enrichSports } from './sports.js';
import { enrichRecipe } from './extras.js';
// GENERATED from src/components/overlayCards/detectSpecialContent.ts (npm run build:detect).
import { detectSpecialContent } from './detect.generated.js';
import { mergeCard } from './merge.js';

const ENRICHERS = {
  weather: enrichWeather,
  finance: enrichFinance,
  system: enrichSystem,
  media_audio: enrichMedia,
  wallet: enrichWallet,
  flight: enrichFlight,
  sports: enrichSports,
  recipe: enrichRecipe,
};

export async function enrichCard(type, data) {
  const fn = ENRICHERS[type];
  if (!fn) return null;
  const result = await fn(data ?? {});
  return result ? { ...result, fetchedAt: Date.now() } : null;
}

export function registerCardRoutes(app) {
  app.post('/api/cards/enrich', async (req, res) => {
    const { type, data } = req.body ?? {};
    try {
      res.json((await enrichCard(type, data)) ?? { data: null });
    } catch (e) {
      console.warn(`[cards] ${type} enrichment failed:`, e.message);
      res.json({ data: null, error: e.message });
    }
  });

  // Apple Watch: turn an agent's reply into a ready-to-render card (detection +
  // real data), since the watch has no detector of its own.
  app.post('/api/cards/detect', async (req, res) => {
    const text = String(req.body?.text ?? '');
    const detected = text ? detectSpecialContent(text, req.body?.agentName) : null;
    if (!detected) return res.json({ card: null });
    try {
      const enrichment = await enrichCard(detected.type, detected.data);
      res.json({ card: { type: detected.type, data: mergeCard(detected.data, enrichment), sources: enrichment?.sources ?? [] } });
    } catch (e) {
      res.json({ card: { type: detected.type, data: detected.data, sources: [] } });
    }
  });

  app.post('/api/cards/media/:action', async (req, res) => {
    try {
      res.json({ data: await spotifyControl(req.params.action) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
