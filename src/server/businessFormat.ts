// Pure helpers for the Business Dashboard (card + Settings → Businesses): wording, validation
// and which view to open on. No React, no store — unit-tested with node --test.

export type BusinessStatus = 'thriving' | 'steady' | 'needs attention';

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", else "Sep 8". */
export function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const date = new Date(t);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}

/** A website the user typed → a normalized https URL, or why it isn't one. */
export function normalizeWebsite(input: string): { url: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Type your website’s address.' };
  if (/\s/.test(raw)) return { error: 'A web address has no spaces.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { return { error: 'That doesn’t look like a web address.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Use an http(s) address.' };
  const host = u.hostname;
  if (!(host === 'localhost' || /\.[a-z]{2,}$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host))) return { error: 'That doesn’t look like a web address.' };
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return { url: `${u.protocol}//${u.host}${path}${u.search}` };
}

/** A path typed in a browser (no native picker): absolute on the computer running Jarvis Server. */
export function validateLocalPath(input: string): { path: string } | { error: string } {
  const p = input.trim().replace(/^["']|["']$/g, '');
  if (!p) return { error: 'Type the path of a folder or file on the computer running Jarvis.' };
  if (!(p.startsWith('/') || p.startsWith('~') || /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\'))) {
    return { error: 'Use the full path, like /Users/you/Projects/my-app.' };
  }
  return { path: p };
}

/** Folder path → "~/Projects/app"; website → "shop.example.com/path". */
export function displayLocation(source: string, location: string): string {
  if (!location) return '';
  if (source === 'website') {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(location) ? location : `https://${location}`);
      return `${u.host.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`;
    } catch {
      return location;
    }
  }
  return location
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
    .replace(/^[a-z]:\\Users\\[^\\]+(?=\\|$)/i, '~');
}

/** A row's title before the analysis names it: the file or folder's name, or the link's host. */
export function sourceTitle(kind: string, target: string): string {
  if (kind === 'website') {
    try { return new URL(/^[a-z]+:\/\//i.test(target) ? target : `https://${target}`).host.replace(/^www\./, ''); } catch { return target; }
  }
  const parts = target.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || target;
}

/** The tile's monogram: the name's first letter or digit. */
export function initialOf(name: string): string {
  const m = (name || '').match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : '•';
}

/** The card's tone: the status when there is one, else the health score's band. */
export function statusTone(status?: BusinessStatus, health?: number): 'success' | 'accent' | 'warning' | 'muted' {
  if (status === 'thriving') return 'success';
  if (status === 'steady') return 'accent';
  if (status === 'needs attention') return 'warning';
  if (typeof health === 'number' && Number.isFinite(health)) return health >= 70 ? 'success' : health >= 40 ? 'accent' : 'warning';
  return 'muted';
}

export const statusLabel = (status?: BusinessStatus) => (status ? status.charAt(0).toUpperCase() + status.slice(1) : '');

/** Which view opens first: the focused business, the portfolio when there are several, else the only one. */
export function initialView(data: { businesses: Array<{ id: string }>; focusId?: string }): string {
  const list = data.businesses || [];
  if (data.focusId && list.some((b) => b.id === data.focusId)) return data.focusId;
  if (list.length > 1) return 'all';
  return list[0]?.id ?? 'all';
}

/** Activity timestamps may come in seconds or milliseconds. */
export const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);

/** "1,240" / "12.5" → a number to count up to (with its decimals); "$12k", "4.8★" → null (shown as is). */
export function countable(value: string): { n: number; decimals: number } | null {
  const v = value.trim();
  if (!/^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return { n, decimals: (v.split('.')[1] || '').length };
}

/** "9 businesses" under a source that holds several. */
export const businessCount = (n: number) => (n > 1 ? `${n} businesses` : '');

/** Portfolio line: "9 businesses · 5 thriving · 1 needs attention" (only statuses that were reported). */
export function portfolioLine(list: Array<{ status?: BusinessStatus }>): string {
  const parts = [`${list.length} ${list.length === 1 ? 'business' : 'businesses'}`];
  for (const s of ['thriving', 'steady', 'needs attention'] as const) {
    const n = list.filter((b) => b.status === s).length;
    if (n) parts.push(`${n} ${s}`);
  }
  return parts.join(' · ');
}

/**
 * Where an <img> loads a business logo from: absolute URLs as they are; a Jarvis Server path
 * ("/api/business/logo/acme.io") on that server, with the key in the query (an <img> sends no
 * headers).
 */
export function logoSrc(url: string | undefined, base: string, key: string): string | undefined {
  if (!url) return undefined;
  if (/^(https?:|data:)/i.test(url)) return url;
  if (!url.startsWith('/')) return undefined;
  const sep = url.includes('?') ? '&' : '?';
  return `${base.replace(/\/+$/, '')}${url}${key ? `${sep}api_key=${encodeURIComponent(key)}` : ''}`;
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', BRL: 'R$', JPY: '¥', CAD: 'CA$', AUD: 'A$', CHF: 'CHF ' };
/** "$" for USD (the currency's symbol, else its code and a space). */
export const currencySymbol = (currency = 'USD') => SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;

/** Gain / loss wording: { sign: '+' | '−' | '', tone: 'success' | 'danger' | 'muted' }. */
export function changeTone(change: number | undefined): { sign: string; tone: 'success' | 'danger' | 'muted' } {
  if (change === undefined || !Number.isFinite(change) || change === 0) return { sign: '', tone: 'muted' };
  return change > 0 ? { sign: '+', tone: 'success' } : { sign: '−', tone: 'danger' };
}

/** "month" → "mo", "year" → "yr" (the period after a revenue figure). */
export const periodShort = (period = 'month') => ({ month: 'mo', year: 'yr', week: 'wk', day: 'day' } as Record<string, string>)[period] ?? period;
