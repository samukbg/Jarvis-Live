// show_card — the voice models' way to put an answer on screen as a live card (the orb's Live
// session and the live avatar's). Spoken answers rarely carry what the text detector needs
// ("14 degrees" has no °, no "weather" word), so the model passes the card's fields, the real
// data fills them in (enrichCard), and the card reaches the apps like the Business Dashboard:
// an agent_result whose text is a sentence + a fenced JSON block (detectSpecialContent).
import { enrichCard } from './index.js';
import { mergeCard } from './merge.js';
import { detectSpecialContent } from './detect.generated.js';

export const CARD_KINDS = ['weather', 'finance', 'sports', 'flight', 'system'];

/** Gemini function declaration (Live API schema). */
export const SHOW_CARD_TOOL = {
  name: 'show_card',
  description:
    "Shows a live card on the user's screen (computer, phone, watch) with real data: the weather of a place, a stock " +
    "or crypto price, a match score, a flight, or this computer's health (CPU, memory, disk, battery). Returns what " +
    'to tell the user.',
  parameters: {
    type: 'OBJECT',
    properties: {
      kind: { type: 'STRING', enum: CARD_KINDS, description: 'weather, finance (stock / crypto / currency), sports, flight, or system (this computer).' },
      summary: { type: 'STRING', description: 'The answer in one short sentence, as you say it to the user.' },
      place: { type: 'STRING', description: 'weather: the city, in English ("Paris", "New York").' },
      day: { type: 'STRING', enum: ['today', 'tomorrow', 'day after tomorrow'], description: 'weather: the day asked about.' },
      temperature: { type: 'NUMBER', description: 'weather: the temperature you found, if any.' },
      unit: { type: 'STRING', enum: ['C', 'F'], description: 'weather: the temperature unit.' },
      condition: { type: 'STRING', description: 'weather: e.g. "Partly cloudy", "Rain".' },
      symbol: { type: 'STRING', description: 'finance: the ticker ("AAPL", "BTC", "EURUSD=X").' },
      assetName: { type: 'STRING', description: 'finance: the company or coin name.' },
      price: { type: 'NUMBER', description: 'finance: the price you found, if any.' },
      changePercent: { type: 'NUMBER', description: "finance: today's change in percent, if known." },
      teamA: { type: 'STRING', description: 'sports: the home team.' },
      teamB: { type: 'STRING', description: 'sports: the away team.' },
      scoreA: { type: 'NUMBER', description: "sports: the home team's score." },
      scoreB: { type: 'NUMBER', description: "sports: the away team's score." },
      league: { type: 'STRING', description: 'sports: the competition.' },
      flightNumber: { type: 'STRING', description: 'flight: e.g. "AF1234".' },
      from: { type: 'STRING', description: 'flight: the departure airport code (IATA, e.g. "CDG").' },
      to: { type: 'STRING', description: 'flight: the arrival airport code (IATA, e.g. "LIS").' },
    },
    required: ['kind', 'summary'],
  },
};

/** Added to the Live instruction wherever the tool is declared. */
export const SHOW_CARD_PROMPT =
  "Your answers can appear as live cards on the user's screens. Never say you cannot show something on screen, in " +
  'the overlay or in a card. For the weather, a stock or crypto price, or this computer\'s health, call `show_card` ' +
  'right away, without searching first: it fetches the real data itself and returns the figures to say. For a match ' +
  'score or a flight, find the teams / flight number first if you need to, then call it. Then tell the user the ' +
  'answer in one or two short sentences, in their language.';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const DAYS = { tomorrow: 1, 'day after tomorrow': 2 };

/** The card's stated fields from the tool's arguments. */
export function statedCard(args = {}) {
  const kind = String(args.kind || '').toLowerCase();
  switch (kind) {
    case 'weather':
      return { type: 'weather', data: compact({ city: str(args.place), temp: num(args.temperature), tempUnit: args.unit === 'F' ? 'F' : args.unit === 'C' ? 'C' : undefined, condition: str(args.condition), forecastDay: DAYS[args.day] }) };
    case 'finance':
      return { type: 'finance', data: compact({ symbol: str(args.symbol)?.toUpperCase(), name: str(args.assetName), price: num(args.price), changePercent: num(args.changePercent) }) };
    case 'sports':
      return { type: 'sports', data: compact({ teamA: compact({ name: str(args.teamA), score: num(args.scoreA) }), teamB: compact({ name: str(args.teamB), score: num(args.scoreB) }), league: str(args.league) }) };
    case 'flight':
      return { type: 'flight', data: compact({ flightNumber: str(args.flightNumber)?.toUpperCase().replace(/\s+/g, ''), origin: compact({ code: str(args.from)?.toUpperCase() }), destination: compact({ code: str(args.to)?.toUpperCase() }) }) };
    case 'system':
      return { type: 'system', data: {} };
    default:
      return null;
  }
}

/** Fills the core fields the card can't do without from the live data. */
function fillCore(type, data) {
  const d = { ...data };
  if (type === 'weather' && d.temp === undefined && num(d.liveTemp) !== undefined) d.temp = d.liveTemp;
  if (type === 'finance' && !d.symbol && d.yahooSymbol) d.symbol = d.yahooSymbol;
  // The apps fetch the live data again (useCardEnrichment): long series stay out of the broadcast.
  for (const [k, v] of Object.entries(d)) if (Array.isArray(v) && JSON.stringify(v).length > 1500) delete d[k];
  for (const [k, v] of Object.entries(d)) if (v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length > 3000) delete d[k];
  return d;
}

/** The card's main figures, for the voice model to say the same numbers the card shows. */
export function cardFacts(type, d) {
  const f = (v, unit = '') => (num(v) !== undefined ? `${Math.round(v * 10) / 10}${unit}` : undefined);
  const join = (xs) => xs.filter(Boolean).join(', ');
  switch (type) {
    case 'weather': {
      const u = `°${d.tempUnit || 'C'}`;
      const day = d.forecastDay ? d.dailyForecast?.[d.forecastDay] : undefined;
      if (day) return join([`${d.city} ${d.forecastDay === 1 ? 'tomorrow' : 'the day after tomorrow'}: ${day.condition || ''}`, day.high !== undefined && `high ${day.high}${u}`, day.low !== undefined && `low ${day.low}${u}`, day.pop !== undefined && `${day.pop}% chance of rain`]);
      return join([`${d.city} now: ${f(d.liveTemp ?? d.temp, u)}`, d.condition, d.high !== undefined && `high ${d.high}${u}`, d.low !== undefined && `low ${d.low}${u}`]);
    }
    case 'finance':
      return join([`${d.name || d.symbol}: ${f(d.price)} ${d.currency || ''}`.trim(), d.changePercent !== undefined && `${d.changePercent >= 0 ? 'up' : 'down'} ${f(Math.abs(d.changePercent), '%')} today`]);
    case 'system':
      return join([d.cpuUsage !== undefined && `CPU ${f(d.cpuUsage, '%')}`, d.ramUsedGB !== undefined && `memory ${f(d.ramUsedGB)} of ${f(d.ramTotalGB)} GB`, d.diskUsedGB !== undefined && `disk ${f(d.diskUsedGB)} of ${f(d.diskTotalGB)} GB`, d.batteryPercent !== undefined && `battery ${f(d.batteryPercent, '%')}`]);
    case 'sports':
      return join([`${d.teamA?.name} ${d.teamA?.score ?? '?'} - ${d.teamB?.score ?? '?'} ${d.teamB?.name}`, d.status]);
    case 'flight':
      return join([`${d.flightNumber} ${d.origin?.code} → ${d.destination?.code}`, d.status]);
    default:
      return '';
  }
}

/** The agent_result text: the sentence, then the card as a fenced JSON block. */
export function cardText(type, summary, data) {
  return `${summary}\n\n\`\`\`json\n${JSON.stringify({ type, summary, data })}\n\`\`\``;
}

/**
 * Builds the card from the tool's arguments and opens it on the apps. Returns { shown, type, text, result }:
 * `result` is what the voice model gets back (it speaks from it).
 */
export async function showCard(args, { broadcast, origin, enrich = enrichCard } = {}) {
  const stated = statedCard(args);
  const summary = str(args?.summary) ?? '';
  if (!stated) return { shown: false, result: `No card for "${args?.kind}". Answer the user in words.` };
  let enrichment = null;
  try {
    enrichment = await enrich(stated.type, stated.data);
  } catch {
    // No live data: the stated fields alone, when they are enough.
  }
  // The model may call before looking anything up: today's real weather beats its guess.
  if (stated.type === 'weather' && !stated.data.forecastDay && num(enrichment?.data?.liveTemp) !== undefined) {
    for (const k of ['temp', 'condition', 'conditionCode']) delete stated.data[k];
    stated.data.temp = enrichment.data.liveTemp;
  }
  const data = fillCore(stated.type, mergeCard(stated.data, enrichment));
  const text = cardText(stated.type, summary || 'Here it is.', data);
  // The same check the apps make: a card without its core fields (no temperature, no price…) is not sent.
  if (!detectSpecialContent(text)) {
    return { shown: false, type: stated.type, result: "That card couldn't be filled with real data. Tell the user the answer in words, briefly." };
  }
  broadcast?.({ type: 'agent_result', agentId: 'jarvis', agentName: 'Jarvis', result: text, isDelegated: true, ...(origin ? { origin } : {}) });
  const facts = cardFacts(stated.type, data);
  return {
    shown: true,
    type: stated.type,
    text,
    result: `The ${stated.type} card is now on the user's screen.${facts ? ` It shows: ${facts}.` : ''} Tell them the answer in one or two short sentences, in their language, with these figures.`,
  };
}
