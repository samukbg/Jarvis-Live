import type { SpecialContentType } from './types';
import { detectSpecialContent } from './detectSpecialContent';

/** One past result card, kept on this device so it can be opened again. */
export interface ResultHistoryEntry {
  id: string;
  /** When it was shown (ms). */
  at: number;
  agentId: string;
  agentName: string;
  /** The full result text, exactly as the card got it (the card is rebuilt from it). */
  result: string;
  /** Detected card type, or null for a plain text answer. */
  type: SpecialContentType | null;
  /** One line for the list ("Tesla · $380.73", "Tokyo · 23°"). */
  title: string;
}

export const HISTORY_MAX = 60;
export const HISTORY_STORAGE_KEY = 'JARVIS_RESULT_HISTORY';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plain = (s: string) => s.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`[\]]/g, '').replace(/\(https?:[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', BRL: 'R$', JPY: '¥', CAD: 'CA$', AUD: 'A$', CHF: 'CHF ' };
const money = (amount: number, currency?: string) => {
  const code = (currency || 'USD').toUpperCase();
  return `${SYMBOLS[code] ?? `${code} `}${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
};

/** The list line for a result: the card's own headline when it has one, else its first sentence. */
export function historyTitle(result: string, agentName = ''): { type: SpecialContentType | null; title: string } {
  const card = detectSpecialContent(result, agentName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = card?.data ?? {};
  let title = '';
  switch (card?.type) {
    case 'weather': title = [d.city, num(d.temp) ? `${Math.round(d.temp)}°` : '', d.condition].filter(Boolean).join(' · '); break;
    case 'finance': title = [d.name || d.symbol, num(d.price) ? money(d.price, d.currency) : ''].filter(Boolean).join(' · '); break;
    case 'flight': title = [d.flightNumber, d.origin?.code && d.destination?.code ? `${d.origin.code} → ${d.destination.code}` : '', d.status ? String(d.status).charAt(0) + String(d.status).slice(1).toLowerCase() : ''].filter(Boolean).join(' · '); break;
    case 'sports': title = d.teamA?.name && d.teamB?.name ? `${d.teamA.name} ${d.teamA.score ?? ''}–${d.teamB.score ?? ''} ${d.teamB.name}` : ''; break;
    case 'recipe': title = d.title || ''; break;
    case 'business_dashboard': {
      const list = Array.isArray(d.businesses) ? d.businesses : [];
      const t = d.totals;
      title = list.length ? `${list.length === 1 ? list[0].name : `${list.length} businesses`}${t && num(t.revenue) ? ` · ${money(t.revenue, t.currency)}/mo` : ''}` : 'Business dashboard';
      break;
    }
    case 'translation': title = d.translatedText ? `“${d.translatedText}”` : ''; break;
    // "Plan" is the detector's stand-in name: the answer's first sentence says more.
    case 'task_roadmap': title = d.projectTitle && d.projectTitle !== 'Plan' ? d.projectTitle : d.description || ''; break;
    case 'chart': title = d.title || ''; break;
    case 'system': title = d.hostname || [num(d.cpuUsage) ? `CPU ${Math.round(d.cpuUsage)}%` : '', num(d.ramUsedGB) && num(d.ramTotalGB) ? `RAM ${Math.round(d.ramUsedGB)}/${Math.round(d.ramTotalGB)} GB` : ''].filter(Boolean).join(' · ') || 'System health'; break;
    case 'wallet': title = d.label || (d.address ? `${String(d.address).slice(0, 6)}…${String(d.address).slice(-4)}` : ''); break;
    case 'media_audio': title = [d.title, d.artist].filter(Boolean).join(' · '); break;
    default: break;
  }
  if (!title) {
    const text = plain(card?.summaryText || result);
    // The first sentence — and the next ones while it's too short to say anything ("Done.").
    title = text.match(/^.{24,}?[.!?](?=\s|$)/)?.[0] || text;
  }
  return { type: card?.type ?? null, title: clip(title || 'Result', 90) };
}

/** Adds a shown result: newest first, the same text only once (moved to the top), at most HISTORY_MAX. */
export function addToHistory(list: ResultHistoryEntry[], entry: { agentId: string; agentName: string; result: string }, now = Date.now()): ResultHistoryEntry[] {
  if (!entry.result || !entry.result.trim()) return list;
  const { type, title } = historyTitle(entry.result, entry.agentName);
  const kept = list.filter((e) => e.result !== entry.result);
  const item: ResultHistoryEntry = { id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: now, agentId: entry.agentId, agentName: entry.agentName, result: entry.result, type, title };
  return [item, ...kept].slice(0, HISTORY_MAX);
}

/** Stored JSON → entries (anything malformed is dropped). */
export function parseHistory(raw: string | null | undefined): ResultHistoryEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((e) => e && typeof e.result === 'string' && typeof e.at === 'number' && typeof e.id === 'string' && typeof e.title === 'string' && typeof e.agentName === 'string').slice(0, HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

/** "Today" / "Yesterday" / "Oct 9" — the list's day headers. */
export function dayLabel(at: number, now = Date.now()): string {
  const d = new Date(at), n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
}
