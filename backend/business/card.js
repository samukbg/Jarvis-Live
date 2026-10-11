// The Business Dashboard card: BusinessDashboardData (src/components/overlayCards/types.ts)
// from the analysed sources, the agent_result text that carries it to the apps (a spoken-style
// sentence + a fenced JSON block, read by detectSpecialContent), and what Jarvis says about it.
//
// The JSON rides in an agent_result broadcast and in the watch's POST /api/cards/detect:
// kept compact (short fields, fewer bullets when many businesses share the card).

/** Gemini function declaration (Live API schema): the orb's session and the live avatar's. */
export const BUSINESS_TOOL = {
  name: 'show_business_dashboard',
  description:
    "Shows the Business Dashboard on the user's screen (an overview of the businesses and projects they added in " +
    'Settings → Businesses: status, health, key numbers, highlights, risks) and returns a short overview to tell them.',
  parameters: {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING', description: 'Optional: the one business or project to focus on, by name.' },
    },
  },
};

/** Added to the Live instruction wherever the tool is declared. */
export const BUSINESS_PROMPT =
  "When the user asks about their business, company, startup, apps or projects (\"How's my business?\", " +
  '"Give me an overview of my projects", "How is <name> doing?"), call `show_business_dashboard` (with `name` ' +
  'for one of them) instead of searching the web or delegating. It opens the dashboard on screen and returns an ' +
  'overview: tell the user the main points in two or three short sentences, in their language. Do not read every ' +
  'number out loud.';

/** The businesses one ready source contributes: its per-business overviews, else its own. */
function businessesOf(source) {
  if (source.status !== 'ready') return [];
  if (Array.isArray(source.overviews) && source.overviews.length) return source.overviews;
  return source.overview ? [source.overview] : [];
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, ' ').trim();

/**
 * The business id to focus on: a business id, a single-business source's id, or a name
 * ("spread out" → "Spread Out"). A portfolio source (several businesses) gets no focus: the
 * card opens on its "All" grid. Undefined when nothing matches.
 */
export function resolveFocus(sources, focus) {
  if (!focus) return undefined;
  const all = sources.flatMap((s) => businessesOf(s).map((b) => ({ b, s })));
  const byId = all.find(({ b }) => b.id === focus);
  if (byId) return byId.b.id;
  const ofSource = all.filter(({ s }) => s.id === focus);
  if (ofSource.length) return ofSource.length === 1 ? ofSource[0].b.id : undefined;
  const q = norm(focus);
  if (!q) return undefined;
  const byName = all.find(({ b }) => norm(b.name) === q) || all.find(({ b }) => norm(b.name).includes(q) || q.includes(norm(b.name)));
  return byName?.b.id;
}

/** BusinessDashboardData from the stored sources. */
export function dashboardData(sources, { focus } = {}) {
  const businesses = sources.flatMap(businessesOf);
  if (!businesses.length) return { businesses: [], empty: true };
  const crowded = businesses.length > 3;
  const cut = (a) => (Array.isArray(a) && a.length ? a.slice(0, crowded ? 2 : 3) : undefined);
  const data = {
    businesses: businesses.map((b) => {
      const out = { ...b, highlights: cut(b.highlights), risks: cut(b.risks), nextSteps: cut(b.nextSteps) };
      for (const k of Object.keys(out)) if (out[k] === undefined || (Array.isArray(out[k]) && !out[k].length)) delete out[k];
      return out;
    }),
  };
  const totals = portfolioTotals(data.businesses);
  if (totals) data.totals = totals;
  const focusId = resolveFocus(sources, focus);
  if (focusId) data.focusId = focusId;
  return data;
}

const cents = (v) => Math.round(v * 100) / 100;

/**
 * The portfolio's overall revenue and its gain / loss: the sum over the businesses that state a
 * revenue (one currency — the most common; others are left out rather than mixed). `change` only
 * counts businesses that also state the previous period's figure. Undefined without revenue.
 */
export function portfolioTotals(businesses) {
  const withRevenue = businesses.filter((b) => b.revenue && Number.isFinite(b.revenue.amount));
  if (!withRevenue.length) return undefined;
  const counts = {};
  for (const b of withRevenue) counts[b.revenue.currency || 'USD'] = (counts[b.revenue.currency || 'USD'] || 0) + 1;
  const currency = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const same = withRevenue.filter((b) => (b.revenue.currency || 'USD') === currency);
  const revenue = cents(same.reduce((s, b) => s + b.revenue.amount, 0));
  const compared = same.filter((b) => Number.isFinite(b.revenue.previous));
  const out = { revenue, currency, period: same[0].revenue.period || 'month', businesses: same.length };
  if (compared.length) {
    const now = compared.reduce((s, b) => s + b.revenue.amount, 0);
    const before = compared.reduce((s, b) => s + b.revenue.previous, 0);
    out.previous = cents(before);
    out.change = cents(now - before);
    if (before > 0) out.changePercent = Math.round(((now - before) / before) * 1000) / 10;
  }
  return out;
}

const money = (v, currency) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v); } catch { return `${v} ${currency}`; }
};

/** "Overall $1,558.72 a month, up $174.30 (12.6%) from last month." — or undefined. */
export function totalsSentence(t) {
  if (!t) return undefined;
  const head = `Overall ${money(t.revenue, t.currency)} a ${t.period || 'month'}`;
  if (t.change === undefined) return `${head}.`;
  if (t.change === 0) return `${head}, flat on the previous ${t.period || 'month'}.`;
  const pct = t.changePercent !== undefined ? ` (${Math.abs(t.changePercent)}%)` : '';
  return `${head}, ${t.change > 0 ? 'up' : 'down'} ${money(Math.abs(t.change), t.currency)}${pct} from last ${t.period || 'month'}.`;
}

const statusWord = (b) => b.status || (b.health !== undefined ? `health ${b.health}/100` : 'analysed');

/** One spoken-style sentence about the dashboard (shown above the card, read by the overlay). */
export function dashboardSummary(data) {
  const list = data.businesses || [];
  if (!list.length) return 'No businesses yet: add a folder, file or website in Settings → Businesses.';
  const focus = data.focusId && list.find((b) => b.id === data.focusId);
  if (focus) return `${focus.name} is ${statusWord(focus)}${focus.tagline ? ` — ${focus.tagline}` : ''}.`;
  if (list.length === 1) return `${list[0].name} is ${statusWord(list[0])}${list[0].tagline ? ` — ${list[0].tagline}` : ''}.`;
  const attention = list.filter((b) => b.status === 'needs attention').map((b) => b.name);
  const thriving = list.filter((b) => b.status === 'thriving').map((b) => b.name);
  const parts = [`Here are your ${list.length} businesses`];
  const overall = totalsSentence(data.totals);
  if (thriving.length) parts.push(`${thriving.slice(0, 3).join(', ')} ${thriving.length === 1 ? 'is' : 'are'} thriving`);
  if (attention.length) parts.push(`${attention.slice(0, 3).join(', ')} ${attention.length === 1 ? 'needs' : 'need'} attention`);
  return `${parts.join('; ')}.${overall ? ` ${overall}` : ''}`;
}

/** The agent_result text: the sentence, then the card as a fenced JSON block. */
export function dashboardText(data) {
  const summary = dashboardSummary(data);
  return `${summary}\n\n\`\`\`json\n${JSON.stringify({ type: 'business_dashboard', summary, data })}\n\`\`\``;
}

/** Plain text for the voice model to speak from: each business, its status and a key fact or two. */
export function spokenOverview(data, { pending = 0 } = {}) {
  const list = data.businesses || [];
  if (!list.length) {
    return pending
      ? 'The business sources are still being analysed; the dashboard opens once they are ready. Tell the user it will take a moment.'
      : 'No businesses added yet. Tell the user to add a folder, file or website in Settings → Businesses, and Jarvis will build their dashboard.';
  }
  const focus = data.focusId && list.find((b) => b.id === data.focusId);
  const lines = (focus ? [focus] : list.slice(0, 10)).map((b) => {
    const facts = (b.kpis || []).slice(0, 2).map((k) => `${k.label} ${k.value}`);
    const note = b.risks?.[0] && b.status === 'needs attention' ? ` Risk: ${b.risks[0]}` : b.highlights?.[0] ? ` ${b.highlights[0]}` : '';
    return `- ${b.name}: ${statusWord(b)}${facts.length ? `; ${facts.join(', ')}` : ''}.${note}`;
  });
  const overall = !focus && totalsSentence(data.totals);
  const head = focus ? 'The dashboard is on screen, focused on this business:' : `The dashboard is on screen with ${list.length} business${list.length > 1 ? 'es' : ''}:${overall ? ` ${overall}` : ''}`;
  return `${head}\n${lines.join('\n')}${pending ? `\n(${pending} more source${pending > 1 ? 's are' : ' is'} still being analysed.)` : ''}`;
}
