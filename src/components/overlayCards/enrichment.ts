// Real data behind the rich result cards (shared by web and mobile — keep identical).
// The backend fetches live values for what the agent stated; the card shows the
// merge. Sections with no real data stay hidden: nothing here is estimated.
import type { SpecialContentType } from './types';

export interface CardEnrichment {
  data: Record<string, unknown> | null;
  /** Which side wins when both have a value: live data or what the agent stated. */
  prefer?: 'live' | 'stated';
  /** Attribution, e.g. ["Open-Meteo"] or ["Spotify · live"]. */
  sources?: string[];
  /** > 0 while the data is live: refetch after this many ms. */
  refreshMs?: number;
  fetchedAt?: number;
}

/** Live state of a card's real data, for cards that animate or control it. */
export interface CardLive {
  live: boolean;
  fetchedAt?: number;
  refresh: () => void;
}

export const ENRICHABLE: ReadonlySet<SpecialContentType> = new Set<SpecialContentType>([
  'weather', 'finance', 'system', 'media_audio', 'wallet', 'flight', 'sports', 'recipe',
]);

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function deepMerge(stated: Record<string, unknown>, live: Record<string, unknown>, prefer: 'live' | 'stated') {
  const out: Record<string, unknown> = { ...stated };
  for (const [k, lv] of Object.entries(live)) {
    const sv = stated[k];
    if (isPlain(sv) && isPlain(lv)) out[k] = deepMerge(sv, lv, prefer);
    else if (isEmpty(sv) || (prefer === 'live' && !isEmpty(lv))) out[k] = lv;
  }
  return out;
}

/** The agent's data with real values filled in (or refreshed, when `prefer` is 'live'). */
export function mergeEnrichment<T>(stated: T, enrichment: CardEnrichment | null | undefined): T {
  if (!enrichment?.data || !isPlain(stated)) return stated;
  return deepMerge(stated, enrichment.data, enrichment.prefer ?? 'stated') as T;
}

export async function fetchEnrichment(baseUrl: string, apiKey: string, type: SpecialContentType, data: unknown): Promise<CardEnrichment | null> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/cards/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ type, data }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as CardEnrichment;
  return json?.data ? json : null;
}

export type MediaAction = 'toggle' | 'next' | 'prev';

export async function sendMediaAction(baseUrl: string, apiKey: string, action: MediaAction) {
  await fetch(`${baseUrl.replace(/\/+$/, '')}/api/cards/media/${action}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
  });
}

/** "2026-09-30T10:00:00Z" → "3 h ago"; leaves other strings untouched. */
export function relativeTime(value: string, now = Date.now()) {
  const t = Date.parse(value);
  if (!Number.isFinite(t) || !/\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** 83.4 → "1:23". */
export const clock = (sec: number) => `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.floor(Math.max(0, sec) % 60)).padStart(2, '0')}`;

/** "1 hr 20 min", "45 minutes", "1h30" → seconds (undefined when no duration is stated). */
export function parseDuration(text: string): number | undefined {
  const h = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?=\b|\d)/i);
  const m = text.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i) ?? (h ? text.match(/h\s*(\d{1,2})\b/i) : null);
  const secs = (h ? parseFloat(h[1]) * 3600 : 0) + (m ? parseInt(m[1], 10) * 60 : 0);
  return secs > 0 ? secs : undefined;
}

/** Calories per macro from stated grams (4 kcal/g protein & carbs, 9 kcal/g fat). */
export function macroCalories(macros: { protein?: string; carbs?: string; fat?: string }) {
  const grams = (v?: string) => { const m = v?.match(/(\d+(?:\.\d+)?)\s*g\b/i); return m ? parseFloat(m[1]) : 0; };
  return { protein: grams(macros.protein) * 4, carbs: grams(macros.carbs) * 4, fat: grams(macros.fat) * 9 };
}
