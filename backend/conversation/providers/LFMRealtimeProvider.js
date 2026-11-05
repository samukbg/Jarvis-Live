// The orb's live voice through Liquid AI's LFM3-Audio, served by llama.cpp's llama-server (b11960)
// at /v1/realtime: on this computer (voice/lfmRuntime.js), on a Jarvis Cloud GPU for paid plans
// (voice/lfmProxy.js), or on a server of the user's own (Settings → Voice → LFM).
//
// What that server does and doesn't do (measured on b11960, see the provider tests):
// - Input is 16 kHz s16 mono only, and there is no server VAD: we detect turns here (RMS) and
//   send input_audio_buffer.commit + response.create ourselves.
// - The model calls tools only in a text-only response. With audio output it says "I'll set a
//   timer" and calls nothing. So each turn runs twice: a text "decision" (a tool call, or
//   reply_directly to just talk), then a spoken response (text + audio) after the tool outputs.
// - The audio transcript is always empty: with ['text', 'audio'] the words come as output_text.
// - Not supported: conversation.item.delete / .truncate, system items, images, voices,
//   tool_choice 'required' (it never ends). response.create needs a new user item or tool output.
// - A response keeps generating after the socket closes: every response has max_output_tokens.
import WebSocket from 'ws';
import { PHONE_ACTION_TOOL } from '../../device/phoneActions.js';
import { BUSINESS_TOOL } from '../../business/card.js';
import { SHOW_CARD_TOOL, showCard } from '../../cards/showCard.js';
import { TranscriptBuffer } from '../transcript.js';
import { webSearch } from '../webSearch.js';
import { realtimeTools } from './OpenAIRealtimeProvider.js';

export const DEFAULT_LFM_MODEL = 'LFM3-Audio-2B-Q4_K_M.gguf';
export const DEFAULT_LOCAL_URL = 'ws://127.0.0.1:9931/v1/realtime';
const LABEL = 'LFM REALTIME';

// 24 kHz s16 mono = 48 bytes/ms; 16 kHz s16 mono = 32 bytes/ms.
const BYTES_PER_MS_24K = 48;
const BYTES_PER_MS_16K = 32;
const PENDING_AUDIO_BYTES = 16000 * 2 * 8; // 8 s held while connecting
const PREROLL_MS = 300; // audio before speech started, sent with it (the first syllable)
const MIN_SPEECH_MS = 120; // louder than the threshold this long = the user is speaking
const MIN_UTTERANCE_MS = 250; // shorter than this = a click or a cough, dropped
const MAX_UTTERANCE_MS = 30000; // committed anyway after this long
const RETRY_MS = [500, 1500, 3000];
const RESPONSE_START_MS = 20000;
const DECIDE_TOKENS = 400; // a tool call with a detailed task fits
const SPEAK_TOKENS = 2048; // text + audio codes of a few sentences
const HISTORY_TURNS = 6;
// A Cloud session holds one of a GPU's few LFM slots: closed after this long without talking,
// opened again when the user speaks.
const CLOUD_IDLE_MS = Number(process.env.LFM_CLOUD_IDLE_MS) || 90_000;
// While Jarvis's voice plays (and just after), its echo can reach the mic: talking over it takes
// a louder, longer voice. The mic stays open (barge-in works), it just needs to be clearly you.
const ECHO_TAIL_MS = 1000;
const ECHO_LOUDER = 3;
const ECHO_MIN_SPEECH_MS = 350;
// The same task asked again this soon is not run again (an echo, or the model retrying a failure).
const REPEAT_TASK_MS = 90_000;

/**
 * The 2B model's instructions: short numbered rules and worked examples, which it follows far
 * better than the other voices' prose (measured with a routing eval over every tool: the shared
 * Live prompt routed 28/49 requests right). `calendar`: whether the calendar tools are declared;
 * `today`: "Friday 6 November 2026" for relative days.
 */
export function lfmRules(agent, { calendar = false, today = null } = {}) {
  const delegate = `delegate_to_${agent}`;
  const cal = calendar
    ? `3. The user's calendar, meetings, appointments, events: what's on, when is something, am I free → calendar_agenda; add, schedule or book → calendar_add_event; move, reschedule, rename → calendar_update_event; cancel, delete, remove → calendar_delete_event. The tools find the event from words of its title: never ask the user for an id or details.\n`
    : `3. Adding a calendar event → phone_action with action "calendar_event".\n`;
  return `You are Jarvis, a voice assistant. Every user turn, call exactly one tool, chosen with these rules in order:
1. Things on the user's phone: timers, alarms, reminders, phone calls, text messages, music (play, pause, next or previous song), directions, opening an app on the phone, flashlight, brightness, Wi-Fi, Bluetooth, volume, do not disturb, dark mode, their Shortcuts → phone_action.
2. Live cards: the weather, rain or temperature → show_card kind "weather"; the price of a stock, a crypto or a currency → show_card kind "finance" with its ticker symbol; this computer's CPU, memory, disk or battery → show_card kind "system"; a flight → show_card kind "flight"; a match score → show_card kind "sports". Never search or delegate these.
${cal}4. Their business, company, apps or projects, how they are doing → show_business_dashboard.
5. News, events, opening hours, results, recent facts, places → search_web.
6. Work on the user's computer: its apps, files, folders, downloads, documents, email, code, scripts, websites to browse, research to write up → ${delegate}, with the user's request written as an instruction.
7. Everything else: greetings, thanks, small talk, jokes, what you can do, opinions, general knowledge → reply_directly.
Always fill "heard" with the user's exact words. Never answer with plain text instead of a tool, and never ask the user for details a tool can work out ("call my mom" → phone_action call with target "mom").

Examples (user → tool and arguments):
"Set a timer for ten minutes" → phone_action {"action":"timer","value":"600"}
"Wake me up at 6:30" → phone_action {"action":"alarm","value":"06:30"}
"Remind me to call the bank at 5 pm" → phone_action {"action":"reminder","text":"Call the bank"}
"Pause the music" → phone_action {"action":"music","value":"pause"}
"Text Paul that I'm on my way" → phone_action {"action":"message","target":"Paul","text":"I'm on my way"}
"Turn on do not disturb" → phone_action {"action":"settings","value":"focus_on"}
"Run my Morning shortcut" → phone_action {"action":"shortcut","target":"Morning"}
"Is it going to rain in Rome tomorrow?" → show_card {"kind":"weather","place":"Rome","day":"tomorrow"}
"How much is Ethereum?" → show_card {"kind":"finance","symbol":"ETH","assetName":"Ethereum"}
"What's Microsoft trading at?" → show_card {"kind":"finance","symbol":"MSFT","assetName":"Microsoft"}
"Dollar to yen rate" → show_card {"kind":"finance","symbol":"USDJPY=X"}
"How much memory is my computer using?" → show_card {"kind":"system"}
${calendar ? `"What do I have on Monday?" → calendar_agenda {"day":"monday"}
"When is my haircut?" → calendar_agenda {"query":"haircut"}
"Put gym tomorrow at 7 am in my calendar" → calendar_add_event {"title":"Gym","start":"<tomorrow's date>T07:00"}
"Push my call with Sara to 4 pm" → calendar_update_event {"event":"Sara","start":"<its date>T16:00"}
"Delete the team lunch" → calendar_delete_event {"event":"team lunch"}
` : ''}"How are my apps doing?" → show_business_dashboard {}
"What's the latest on the elections?" → search_web {"query":"latest election news"}
"Open my Downloads folder and find the invoice from Amazon" → ${delegate} {"task":"Open the Downloads folder and find the invoice from Amazon"}
"Check my inbox for anything urgent" → ${delegate} {"task":"Check my email inbox for urgent messages"}
"Tell me a fun fact" → reply_directly {}
${today ? `\nToday is ${today}.\n` : ''}
After a tool, speak to the user in one or two short sentences, in English. When an agent fails, say what happened; never delegate the same task again unless the user asks again.

`;
}

/**
 * The session's instructions: the rules, then the shared voice prompt (for the spoken answers:
 * cards, phone actions, agent results), then the turns before a drop.
 */
export function lfmInstructions(agent, history = [], { calendar = null, now = Date.now() } = {}) {
  const today = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(now));
  // Not the shared Live prompt: it sends weather and prices to a web search, and the 2B model
  // followed it over the rules.
  let text = `${lfmRules(agent, { calendar: !!calendar, today })}The agent's answers come back later as a message starting with "(Agent result)": tell the user what it says, briefly and naturally. For messages and calls, say who it is for; the phone asks the user to confirm.${calendar ? `\n\n${calendar}` : ''}`;
  if (history.length) {
    text += `\n\nThe conversation so far (the connection dropped; carry on from here without mentioning it):\n${history.map((h) => `${h.role === 'user' ? 'User' : 'Jarvis'}: ${h.text}`).join('\n')}`;
  }
  return text;
}

/** The legacy rule block (kept for tests that check the shape of the instructions). */
export const LFM_RULES = lfmRules('agy');

/** Talking without a tool: in a text decision the 2B model always reaches for a tool, so it gets one. */
export const REPLY_TOOL = {
  type: 'function',
  name: 'reply_directly',
  description: 'Answer the user yourself, out loud, with no other tool: greetings, thanks, small talk, how you are, what you can do, opinions, jokes, and general knowledge you already know (science, history, definitions, fun facts, advice).',
  parameters: { type: 'object', properties: {}, required: [] },
};

/** Every LFM tool asks first for the user's words: the guard below checks the choice against them. */
const HEARD = { type: 'string', description: "The user's exact words." };
export const lfmTools = (agent, opts) => [REPLY_TOOL, ...realtimeTools(agent, opts)].map((t) => ({
  ...t,
  parameters: { ...t.parameters, properties: { heard: HEARD, ...t.parameters.properties }, required: ['heard', ...(t.parameters.required || [])] },
}));

/**
 * What the user clearly asked for, from their words: { tool, hint } when the words leave no
 * doubt (a timer is a phone action, Bitcoin's price is a card…), else null. Conservative on
 * purpose: it only overrules the model where the 2B model was measured to go wrong.
 */
export function intentOf(words, agent = 'agy', { calendar = true } = {}) {
  const t = ` ${String(words || '').toLowerCase()} `;
  if (!t.trim()) return null;
  const computer = /\b(on|in|from) (my|the) (computer|mac|laptop|pc|desktop)\b|\b(file|files|folder|folders|downloads?|documents?|pdf|script|code|repo|project|vs ?code|terminal|inbox|e-?mails?|spreadsheet|excel|word document|python|javascript|website|program)\b/;
  const phone = { tool: PHONE_ACTION_TOOL.name };
  if (/\b(timer|alarm|wake me( up)?|remind me|reminder|flashlight|torch|brightness|do not disturb|airplane mode|low power|dark mode|light mode|wi-?fi|bluetooth|volume)\b/.test(t) && !computer.test(t)) return { ...phone, hint: 'a phone action (timer, alarm, reminder or phone setting)' };
  if (/\b(shortcut)\b/.test(t) && !computer.test(t)) return { ...phone, hint: 'phone_action with action "shortcut"' };
  if (/\b(call|phone|ring|facetime)\b \w+/.test(t) && /^ *(please )?(call|phone|ring|facetime)\b/.test(t)) return { ...phone, hint: 'phone_action with action "call"' };
  if (/\b(text|message|sms|whatsapp)\b/.test(t) && /\b(send|text|message|tell)\b/.test(t) && !computer.test(t) && !/\bemail\b/.test(t)) return { ...phone, hint: 'phone_action with action "message"' };
  if (/\b(pause|resume|skip|next|previous)\b.*\b(music|song|track)\b|\b(pause|stop) the music\b|\bnext song\b/.test(t) && !/\bspotify\b/.test(t)) return { ...phone, hint: 'phone_action with action "music"' };
  if (/\b(directions|navigate|take me) to\b/.test(t)) return { ...phone, hint: 'phone_action with action "navigate"' };
  if (/\b(on|in) my (phone|iphone)\b/.test(t)) return { ...phone, hint: 'phone_action: it is on the phone' };
  if (/\b(weather|forecast|rain|raining|snow|snowing|sunny|cloudy|windy|umbrella|jacket|coat|temperature|degrees|how (hot|cold|warm))\b/.test(t) && !computer.test(t) && !/\b(cpu|gpu|computer|mac)\b/.test(t)) return { tool: SHOW_CARD_TOOL.name, hint: 'show_card with kind "weather"' };
  const asset = /\b(bitcoin|btc|ethereum|ether|eth|crypto|solana|dogecoin|xrp|cardano|stocks?|shares?|nasdaq|s&p|dow jones|exchange rate|euro|dollar|pound|yen|apple|tesla|nvidia|microsoft|amazon|google|meta)\b/;
  if (asset.test(t) && /\b(price|cost|worth|value|how much|trading|quote|rate|doing today|up|down)\b/.test(t) && !computer.test(t) && !/\b(script|track|chart|csv|history|news)\b/.test(t)) return { tool: SHOW_CARD_TOOL.name, hint: 'show_card with kind "finance" and the ticker symbol' };
  if (/\b(cpu|processor|ram|memory|disk|storage|battery)\b/.test(t) && /\b(my|this|the) (computer|mac|laptop|pc)\b|\bmy computer'?s\b/.test(t)) return { tool: SHOW_CARD_TOOL.name, hint: 'show_card with kind "system"' };
  if (/\bflight\b/.test(t) && /\b[a-z]{2} ?\d{2,4}\b/.test(t)) return { tool: SHOW_CARD_TOOL.name, hint: 'show_card with kind "flight"' };
  if (calendar && /\b(calendar|agenda|schedule|meeting|meetings|appointment|appointments|event|events)\b/.test(t) && !computer.test(t)) {
    if (/\b(cancel|delete|remove)\b/.test(t)) return { tool: 'calendar_delete_event', hint: 'calendar_delete_event with words of the event title' };
    if (/\b(move|reschedule|push|postpone|change|rename)\b/.test(t)) return { tool: 'calendar_update_event', hint: 'calendar_update_event with words of the event title' };
    if (/\b(add|put|schedule|book|create|set up)\b/.test(t) && !/\bwhat\b/.test(t)) return { tool: 'calendar_add_event', hint: 'calendar_add_event' };
    return { tool: 'calendar_agenda', hint: 'calendar_agenda' };
  }
  if (/\b(my|our) (business|businesses|company|startup|projects|apps)\b/.test(t) && !computer.test(t)) return { tool: BUSINESS_TOOL.name, hint: 'show_business_dashboard' };
  if (computer.test(t) && /\b(open|find|create|make|write|check|move|copy|delete|rename|search|organi[sz]e|clean|run|build|fix|look)\b/.test(t)) return { tool: `delegate_to_${agent}`, hint: `${`delegate_to_${agent}`}: it is work on the user's computer` };
  return null;
}

/**
 * The model chose `name` with `args` (args.heard: the user's words). When the words clearly ask
 * for another tool, that tool and why — the model decides again with it named — else null.
 * reply_directly is overruled too: the 2B model "answers" prices and timers itself.
 */
export function rerouteFor(name, args, agent = 'agy', { calendar = true } = {}) {
  const words = args?.heard || (name === `delegate_to_${agent}` ? args?.task : name === 'search_web' ? args?.query : '');
  const want = intentOf(words, agent, { calendar });
  if (!want || want.tool === name) return null;
  // A search for news about a company is not its share price; a delegation that mentions a
  // timer inside a script is not a timer (intentOf already excludes computer words).
  return want;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The day the user's words name ("tomorrow", "on Friday", "next Tuesday") as YYYY-MM-DD, else null. */
export function dayFromWords(words, now = Date.now()) {
  const t = String(words || '').toLowerCase();
  const day = 86_400_000;
  if (/\bday after tomorrow\b/.test(t)) return localDate(now + 2 * day);
  if (/\btomorrow\b/.test(t)) return localDate(now + day);
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) return localDate(now);
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (wd < 0) return null;
  const ahead = (wd - new Date(now).getDay() + 7) % 7 || 7;
  return localDate(now + ahead * day);
}

const TICKERS = { bitcoin: 'BTC', ethereum: 'ETH', ether: 'ETH', solana: 'SOL', dogecoin: 'DOGE', xrp: 'XRP', cardano: 'ADA', litecoin: 'LTC', apple: 'AAPL', tesla: 'TSLA', nvidia: 'NVDA', microsoft: 'MSFT', amazon: 'AMZN', google: 'GOOGL', alphabet: 'GOOGL', meta: 'META', netflix: 'NFLX' };
const CURRENCIES = { euro: 'EUR', euros: 'EUR', dollar: 'USD', dollars: 'USD', pound: 'GBP', pounds: 'GBP', yen: 'JPY', franc: 'CHF', francs: 'CHF', real: 'BRL', reais: 'BRL' };

/** "How much is Bitcoin?" → { symbol: 'BTC', assetName: 'Bitcoin' }; "euro to dollar" → EURUSD=X. */
export function assetFromWords(words) {
  const t = String(words || '').toLowerCase();
  const coin = Object.keys(TICKERS).find((k) => new RegExp(`\\b${k}\\b`).test(t));
  if (coin) return { symbol: TICKERS[coin], assetName: coin[0].toUpperCase() + coin.slice(1) };
  const cur = [...t.matchAll(/\b(euros?|dollars?|pounds?|yen|francs?|real|reais)\b/g)].map((m) => CURRENCIES[m[1]]);
  const pair = [...new Set(cur)];
  if (pair.length >= 2) return { symbol: `${pair[0]}${pair[1]}=X` };
  return null;
}

/**
 * The 2B model's arguments, mended from the user's own words (args.heard): it gets relative
 * dates wrong ("tomorrow" a week off), leaves targets empty ("Ring my brother" → target ""),
 * writes summaries as instructions ("Provide the price of…") and plays instead of skipping.
 * Returns the arguments the tool runs with (without `heard`).
 */
export function repairArgs(name, args = {}, { now = Date.now() } = {}) {
  const { heard: rawHeard, ...out } = args || {};
  const heard = String(rawHeard || '').trim();
  const t = heard.toLowerCase();
  const empty = (v) => v === undefined || v === null || String(v).trim() === '';
  const tail = (re) => (re.exec(heard)?.[1] || '').replace(/[.?!]+$/, '').trim();
  if (name === PHONE_ACTION_TOOL.name) {
    if (out.action === 'music' && heard) {
      const v = /\b(next|skip)\b/.test(t) ? 'next' : /\b(previous|last song|go back)\b/.test(t) ? 'previous' : /\b(pause|stop)\b/.test(t) ? 'pause' : null;
      if (v) out.value = v;
    }
    if (out.action === 'call' && empty(out.target)) out.target = tail(/\b(?:call|ring|phone|facetime)\s+(.+)$/i);
    if (out.action === 'navigate' && empty(out.target)) out.target = tail(/\b(?:to|towards)\s+(.+)$/i);
    if (out.action === 'message' && empty(out.target)) out.target = tail(/\b(?:text|message|tell)\s+([A-Z]?\w+)/i);
    if (out.action === 'timer' && heard && empty(out.value)) out.value = heard;
  }
  if (name === SHOW_CARD_TOOL.name) {
    // A summary the model wrote before having the figures is a question or an order, not an answer.
    if (/^(provide|get|show|check|find|display|fetch|look)\b|\?$/i.test(String(out.summary || '').trim())) out.summary = '';
    if (out.kind === 'finance' && heard && !out.symbol) Object.assign(out, assetFromWords(heard) || {});
    if (out.kind === 'weather' && heard) {
      if (empty(out.place)) out.place = tail(/\bin ([A-Z][\w'’.-]*(?: [A-Z][\w'’.-]*)*)/);
      if (/\bday after tomorrow\b/.test(t)) out.day = 'day after tomorrow';
      else if (/\btomorrow\b/.test(t)) out.day = 'tomorrow';
    }
  }
  if (/^calendar_(add|update)_event$/.test(name) && heard && typeof out.start === 'string') {
    const day = dayFromWords(heard, now);
    const m = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2})?$/.exec(out.start.trim());
    // "On Friday" said on a Friday: today or next week are both fair, the model's pick stands.
    const sameWeekday = m && WEEKDAYS.some((w) => t.includes(w)) && new Date(`${m[1]}T12:00:00`).getDay() === new Date(`${day}T12:00:00`).getDay() && m[1] >= localDate(now);
    if (day && m && m[1] !== day && !sameWeekday) out.start = `${day}${m[2] || ''}`;
    if (day && !m && /^T?\d{2}:\d{2}$/.test(out.start.trim())) out.start = `${day}T${out.start.trim().replace(/^T/, '')}`;
  }
  if (/^calendar_(update|delete)_event$/.test(name) && empty(out.event) && heard) {
    out.event = tail(/\b(?:cancel|delete|remove|move|reschedule|push|postpone|change|rename)\s+(?:my |the |our )?(.+?)(?:\s+(?:to|from|on|at|until|for)\b.*)?$/i) || heard.replace(/[.?!]+$/, '');
  }
  return out;
}

/** Words of a task, to spot the same task asked twice. */
const taskWords = (t) => new Set(String(t || '').toLowerCase().match(/[a-z0-9à-ÿ]+/g)?.filter((w) => w.length > 2) || []);
export function sameTask(a, b) {
  const x = taskWords(a), y = taskWords(b);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common += 1;
  return common / Math.min(x.size, y.size) >= 0.6;
}

/** Delegations that are really a phone action, a price or the weather (rerouteFor, from the task). */
export function misroutedTask(task) {
  return rerouteFor('delegate_to_agy', { task }, 'agy')?.tool || null;
}

/**
 * Resamples 24 kHz 16-bit signed mono PCM to 16 kHz 16-bit signed mono PCM using linear interpolation.
 * Exact 3:2 ratio: 3 input samples -> 2 output samples.
 */
export function resample24kTo16k(pcm24k) {
  if (!pcm24k || pcm24k.length < 2) return Buffer.alloc(0);
  const inSamples = Math.floor(pcm24k.length / 2);
  const outSamples = Math.floor(inSamples * 2 / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = i * 1.5;
    const idx0 = Math.floor(srcIdx);
    const idx1 = Math.min(idx0 + 1, inSamples - 1);
    const frac = srcIdx - idx0;
    const s0 = pcm24k.readInt16LE(idx0 * 2);
    const s1 = pcm24k.readInt16LE(idx1 * 2);
    const sample = Math.round(s0 * (1 - frac) + s1 * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return out;
}

/** Computes Root-Mean-Square (RMS) amplitude of 16-bit PCM audio. */
export function calculateRms(pcm16) {
  if (!pcm16 || pcm16.length < 2) return 0;
  let sum = 0;
  const count = Math.floor(pcm16.length / 2);
  for (let i = 0; i < count; i++) {
    const s = pcm16.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / count);
}

/** The words to show and remember: the model sometimes thinks out loud in <think> tags. */
export function spokenText(text) {
  return String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

export class LFMRealtimeProvider {
  constructor(options = {}) {
    // endpoint(): { url, headers, cloud, remainingS } — server.js picks local, Cloud or custom.
    // It throws when there is none (e.fallback: Gemini Live may take over).
    this.endpoint = options.endpoint || (async () => ({ url: process.env.LFM_REALTIME_URL || DEFAULT_LOCAL_URL, headers: {} }));
    this.modelGetter = options.model || (() => process.env.LFM_MODEL || DEFAULT_LFM_MODEL);
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.search = options.search || webSearch;
    this.broadcast = options.broadcast || (() => {});
    this.broadcastAudioChunk = options.broadcastAudioChunk || (() => {});
    this.broadcastLog = options.broadcastLog || (() => {});
    this.broadcastNotification = options.broadcastNotification || (() => {});
    this.broadcastAgentStatus = options.broadcastAgentStatus || (() => {});
    this.delegateToAgent = options.delegateToAgent || (async () => 'Done.');
    this.phoneBridge = options.phoneBridge || null;
    this.business = options.business || null;
    this.calendar = options.calendar || null;
    this.showCard = options.showCard || showCard;
    this.forSpeaker = options.forSpeaker || ((fn) => fn());
    // Called when LFM can't be reached: server.js moves the session to Gemini Live if it can.
    this.onUnavailable = options.onUnavailable || null;
    // Called with { cloud, remainingS } once a session is open (Cloud voice minutes).
    this.onSession = options.onSession || (() => {});

    this.vadThreshold = Number(process.env.LFM_VAD_THRESHOLD) || 350;
    this.silenceDurationMs = Number(process.env.LFM_SILENCE_MS) || 600;

    this.ws = null;
    this.session = null;
    this.cloud = false;
    this.connecting = false;
    this.wanted = false;
    this.retries = 0;
    this.retryTimer = null;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.jarvisSpeech = new TranscriptBuffer();
    this.history = [];
    this.dropped = false;
    this.targetAgent = 'agy';
    this.parked = false; // an idle Cloud session closed on purpose (see park)
    this.idleTimer = null;
    this.delegations = 0; // agent tasks still running: their answer must be spoken
    this.recentTasks = []; // [{ task, at, result }] for REPEAT_TASK_MS
    this.lastAudioAt = 0;

    // Responses: phase 'warmup' | 'decide' | 'speak' of the one in flight (the server runs one at a time).
    this.responding = null;
    this.next = null; // 'decide' | 'speak' — asked for while a response was running
    this.responseTimer = null;
    this.cancelled = false;
    this.speaking = false;
    this.playing = null;

    // Turn detection
    this.preroll = [];
    this.prerollBytes = 0;
    this.loudMs = 0;
    this.speechActive = false;
    this.utteranceMs = 0;
    this.silenceMs = 0;
  }

  send(event) {
    const ws = this.session;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  appendAudio(pcm16) {
    if (this.session) return this.send({ type: 'input_audio_buffer.append', audio: pcm16.toString('base64') });
    this.pendingAudio.push(pcm16);
    this.pendingBytes += pcm16.length;
    while (this.pendingBytes > PENDING_AUDIO_BYTES) this.pendingBytes -= this.pendingAudio.shift().length;
    return true;
  }

  /**
   * One mic chunk (24 kHz s16 PCM). Only speech is sent (with a short lead-in): the buffer
   * becomes the user's turn on commit, and silence would only slow the model down.
   */
  sendAudio(pcm24k) {
    if (!this.wanted || !pcm24k || pcm24k.length < 2) return false;
    if (!this.session && !this.connecting && !this.retryTimer && !this.parked) this.connect(this.targetAgent);
    const pcm16 = resample24kTo16k(pcm24k);
    if (!pcm16.length) return false;
    const ms = pcm16.length / BYTES_PER_MS_16K;
    const echo = this.echoLikely();
    const loud = calculateRms(pcm16) >= this.vadThreshold * (echo && !this.speechActive ? ECHO_LOUDER : 1);

    if (!this.speechActive) {
      this.preroll.push(pcm16);
      this.prerollBytes += pcm16.length;
      while (this.prerollBytes - this.preroll[0].length >= PREROLL_MS * BYTES_PER_MS_16K) this.prerollBytes -= this.preroll.shift().length;
      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.loudMs < (echo ? ECHO_MIN_SPEECH_MS : MIN_SPEECH_MS)) return true;
      this.startUtterance();
      return true;
    }

    this.appendAudio(pcm16);
    this.utteranceMs += ms;
    this.silenceMs = loud ? 0 : this.silenceMs + ms;
    if (this.silenceMs >= this.silenceDurationMs || this.utteranceMs >= MAX_UTTERANCE_MS) this.endUtterance();
    return true;
  }

  startUtterance() {
    this.speechActive = true;
    this.active();
    if (this.parked) {
      this.parked = false;
      this.connect(this.targetAgent);
    }
    this.silenceMs = 0;
    this.utteranceMs = this.prerollBytes / BYTES_PER_MS_16K;
    // The user talks over Jarvis: stop the reply (barge-in). A decision still running is for
    // words the user is now adding to: it is redone when they stop.
    if (this.responding === 'speak' || this.audioPlaying()) this.interrupt();
    else if (this.responding === 'decide') this.cancel();
    this.send({ type: 'input_audio_buffer.clear' });
    for (const chunk of this.preroll) this.appendAudio(chunk);
    this.preroll = [];
    this.prerollBytes = 0;
    this.loudMs = 0;
  }

  endUtterance() {
    this.redirected = false;
    const voiced = this.utteranceMs - this.silenceMs;
    this.speechActive = false;
    this.silenceMs = 0;
    this.utteranceMs = 0;
    if (voiced < MIN_UTTERANCE_MS) {
      this.send({ type: 'input_audio_buffer.clear' });
      return;
    }
    if (this.session) {
      this.send({ type: 'input_audio_buffer.commit' });
      this.request('decide');
    } else {
      this.pendingCommit = true;
    }
  }

  flushPendingAudio() {
    const chunks = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    for (const pcm16 of chunks) {
      if (!this.send({ type: 'input_audio_buffer.append', audio: pcm16.toString('base64') })) return;
    }
    if (this.pendingCommit) {
      this.pendingCommit = false;
      this.send({ type: 'input_audio_buffer.commit' });
      this.request('decide');
    }
  }

  /** The model has no vision: camera and screen frames are not sent. */
  sendImage() {}

  remember(role, text) {
    const t = String(text || '').trim();
    if (!t) return;
    this.history.push({ role, text: t.slice(0, 500) });
    if (this.history.length > HISTORY_TURNS) this.history.splice(0, this.history.length - HISTORY_TURNS);
  }

  scheduleReconnect() {
    if (!this.wanted || this.retryTimer || this.connecting) return;
    const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && !this.session) this.connect(this.targetAgent);
    }, delay);
    this.retryTimer.unref?.();
  }

  /** LFM can't be reached: say why and let server.js move the session to another voice. */
  unavailable(message, { quiet = false } = {}) {
    this.broadcastLog(`[LFM] ${message}`);
    // server.js says what happens next (another voice, or waiting for the model).
    if (!quiet && !this.onUnavailable) this.broadcastNotification({ label: LABEL, msg: message, kind: 'warn' });
    const pending = this.pendingAudio;
    this.disconnect();
    if (typeof this.onUnavailable === 'function') this.onUnavailable({ message, pendingAudio: pending });
  }

  async connect(targetAgent = 'agy') {
    if (this.connecting) return;
    if (this.session) {
      if (this.targetAgent === targetAgent) return;
      this.disconnect();
      this.history = [];
    }

    this.connecting = true;
    this.wanted = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.targetAgent = targetAgent;

    const reconnect = this.dropped;
    this.dropped = false;
    if (!reconnect) this.history = [];

    let ep;
    try {
      ep = await this.endpoint();
    } catch (e) {
      this.connecting = false;
      if (!this.wanted) return;
      this.unavailable(e.message || 'LFM voice is not available.', { quiet: !!e.quiet });
      return;
    }
    if (!this.wanted) {
      this.connecting = false;
      return;
    }
    this.cloud = !!ep.cloud;
    const where = ep.cloud ? 'Jarvis Cloud' : ep.url;
    console.log(`[LFM] Connecting to LFM Realtime (${where})...`);
    this.broadcastLog(`[LFM] Connecting to LFM Realtime (${where})...`);

    let ws;
    try {
      ws = new this.WebSocketImpl(ep.url, { headers: ep.headers || {} });
    } catch (e) {
      this.connecting = false;
      this.unavailable(`Connection failed: ${e.message}`);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.session = ws;
      this.everOpened = true;
      this.connecting = false;
      this.responding = null;
      this.next = null;
      this.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: this.modelGetter(),
          instructions: lfmInstructions(this.targetAgent, reconnect ? this.history : [], { calendar: this.calendar?.prompt() || null }),
          output_modalities: ['text'],
          audio: {
            input: { format: { type: 'audio/pcm', rate: 16000 } },
            output: { format: { type: 'audio/pcm', rate: 24000 } },
          },
          tools: lfmTools(this.targetAgent, { calendar: !!this.calendar }),
          tool_choice: 'auto',
        },
      });
      this.announce = !reconnect;
      this.onSession({ cloud: this.cloud, remainingS: ep.remainingS ?? null });
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      this.forSpeaker(() => this.onEvent(event));
    });

    ws.on('error', (e) => {
      const lastError = e?.message || String(e);
      console.error('[LFM] Error:', lastError);
      this.broadcastLog(`[LFM ERROR] ${lastError}`);
    });

    ws.on('close', (code, reason) => {
      const why = reason?.toString?.() || '';
      console.log(`[LFM] Realtime Session Closed — code:${code} reason:${why || 'none'}`);
      if (this.ws !== ws) return;
      const opened = this.session === ws;
      this.ws = null;
      this.session = null;
      this.connecting = false;
      this.endResponse();
      if (!this.wanted) return;
      this.dropped = opened || this.dropped;
      // 1008 = the Cloud token ended (an hour at most): connecting again asks for a new one
      // (or uses this computer when the plan's minutes are gone).
      // Never reached: one quick retry, then another voice (the user is waiting to talk).
      if (this.retries >= (this.everOpened ? RETRY_MS.length : 1)) return this.unavailable('The LFM voice server is not responding.');
      this.scheduleReconnect();
    });
  }

  /**
   * The first turn on a new session pays ~3 s to read the instructions and tools: done now,
   * with a throwaway item (items can't be deleted), so the user's first question is quick.
   */
  warmUp() {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '(The voice session is open. Wait for the user to speak.)' }] } });
    this.start('warmup');
  }

  onEvent(event) {
    switch (event.type) {
      case 'session.updated':
        if (this.warmedUp === this.session) break;
        this.warmedUp = this.session;
        this.retries = 0;
        console.log('[LFM] Realtime connected');
        this.broadcastLog(`[LFM] Realtime Session Active ● (${this.cloud ? 'Jarvis Cloud' : 'local'})`);
        if (this.announce) this.broadcastNotification({ label: LABEL, msg: `LFM voice connected${this.cloud ? ' (Jarvis Cloud)' : ''}`, kind: 'success' });
        this.announce = false;
        this.warmUp();
        this.flushPendingAudio();
        this.active();
        break;

      case 'response.created':
        clearTimeout(this.responseTimer);
        break;

      case 'response.output_item.added':
        // A plain answer in a decision (no tool): stop it, it has no audio.
        if (this.responding === 'decide' && event.item?.type === 'message' && !this.cancelled) {
          this.plainAnswer = true;
          this.cancel();
        }
        break;

      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (this.responding === 'speak') this.onAudio(event);
        break;

      case 'response.output_text.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (this.responding === 'speak') this.onWords(event.delta || '');
        break;

      case 'response.done':
        this.onResponseDone(event.response || {});
        break;

      case 'error': {
        const err = event.error || {};
        console.error('[LFM] Server error:', err.code, err.message);
        this.broadcastLog(`[LFM ERROR] ${err.message || err.code}`);
        break;
      }

      default:
        break;
    }
  }

  onWords(delta) {
    const text = spokenText(this.jarvisSpeech.add(delta));
    if (text) this.broadcast({ type: 'voice_transcript', text, role: 'assistant', is_final: false });
  }

  onAudio(event) {
    if (!event.delta) return;
    this.active();
    if (!this.speaking) {
      this.speaking = true;
      this.broadcast({ type: 'agent_status', agentId: this.targetAgent, status: 'THINKING', voice: true });
    }
    const pcm = Buffer.from(event.delta, 'base64');
    if (!this.playing || this.playing.itemId !== event.item_id) {
      this.playing = { itemId: event.item_id, startedAt: Date.now(), ms: 0 };
    }
    this.playing.ms += pcm.length / BYTES_PER_MS_24K;
    this.broadcastAudioChunk(pcm);
    this.broadcast({ type: 'tts_chunk', content: event.delta, isPcm: true, format: 'pcm' });
  }

  /** Audio generates faster than it plays: "playing" lasts until the last chunk has been heard. */
  audioPlaying() {
    return !!this.playing && Date.now() < this.playing.startedAt + this.playing.ms + 300;
  }

  /** Jarvis is talking, or just stopped: what the mic hears may be its own voice. */
  echoLikely() {
    const p = this.playing;
    return !!p && Date.now() < p.startedAt + p.ms + ECHO_TAIL_MS;
  }

  interrupt() {
    this.broadcast({ type: 'gemini_live_interrupt' });
    this.playing = null;
    this.jarvisSpeech.flush();
    if (this.responding && this.responding !== 'warmup') this.cancel();
  }

  /** Stops the running response; its tool calls, if any, are dropped (see onResponseDone). */
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.send({ type: 'response.cancel' });
  }

  endResponse() {
    clearTimeout(this.responseTimer);
    this.responding = null;
    this.next = null;
    this.cancelled = false;
    if (this.speaking) {
      this.speaking = false;
      this.broadcast({ type: 'agent_status', agentId: this.targetAgent, status: 'IDLE', voice: true });
    }
  }

  /** Asks for a response, or queues it behind the one running. */
  request(phase) {
    if (!this.session) return;
    if (this.responding) {
      // A new user turn beats a pending spoken reply.
      if (!this.next || phase === 'decide') this.next = phase;
      return;
    }
    this.start(phase);
  }

  start(phase) {
    const speak = phase === 'speak';
    if (!this.send({
      type: 'response.create',
      response: { output_modalities: speak ? ['text', 'audio'] : ['text'], max_output_tokens: phase === 'warmup' ? 1 : speak ? SPEAK_TOKENS : DECIDE_TOKENS },
    })) return;
    this.responding = phase;
    this.cancelled = false;
    this.plainAnswer = false;
    clearTimeout(this.responseTimer);
    // No response.done (an error, a dropped event): don't stay "busy" forever.
    this.responseTimer = setTimeout(() => this.forSpeaker(() => this.onResponseDone({ status: 'timeout' })), RESPONSE_START_MS);
    this.responseTimer.unref?.();
  }

  onResponseDone(response) {
    clearTimeout(this.responseTimer);
    const phase = this.responding;
    const cancelled = this.cancelled || response.status === 'cancelled';
    const plainAnswer = this.plainAnswer;
    this.responding = null;
    this.cancelled = false;
    this.plainAnswer = false;
    const output = response.output || [];

    if (phase === 'speak') {
      const said = spokenText(this.jarvisSpeech.flush());
      if (said) {
        this.broadcast({ type: 'voice_transcript', text: said, role: 'assistant', is_final: true });
        this.remember('assistant', said);
      }
      if (this.speaking) {
        this.speaking = false;
        this.broadcast({ type: 'agent_status', agentId: this.targetAgent, status: 'IDLE', voice: true });
      }
    }

    const queued = this.next;
    this.next = null;
    if (phase === 'decide' && queued !== 'decide') {
      const calls = output.filter((o) => o.type === 'function_call');
      if (calls.length && !cancelled) return this.runTools(calls);
      // A plain answer (stopped above): it can only be spoken after a new item.
      if ((plainAnswer || output.some((o) => o.type === 'message')) && this.session) {
        this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '(Say your answer out loud.)' }] } });
        return this.start('speak');
      }
    }
    if (queued) this.start(queued);
  }

  async runTools(calls) {
    const session = this.session;
    // An agent that answers at once still answers after its tool output.
    let outputsSent;
    const sent = new Promise((resolve) => { outputsSent = resolve; });
    let redecide = false;
    const outputs = await Promise.all(calls.map(async (call) => {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch {}
      const name = call.name;
      let output;

      if (!this.redirected && rerouteFor(name, args, this.targetAgent, { calendar: !!this.calendar })) {
        // The user's words clearly ask for another tool (a timer, a price, the weather…): once
        // per turn, the model chooses again with that tool named, before anything runs.
        const want = rerouteFor(name, args, this.targetAgent, { calendar: !!this.calendar });
        this.redirected = true;
        this.turnHeard = String(args.heard || '');
        redecide = true;
        this.broadcastLog(`[LFM REALTIME] ${name} doesn't fit "${args.heard || args.task || args.query || ''}": asking for ${want.tool}`);
        output = { error: `Wrong tool: this is ${want.hint}. Call ${want.tool} for it now.` };
      } else if (name === REPLY_TOOL.name) {
        output = { ok: true, note: 'Answer the user now, out loud, in one or two short sentences.' };
      } else if (name === `delegate_to_${this.targetAgent}` && this.repeatOf(String(args.task || ''))) {
        const prev = this.repeatOf(String(args.task || ''));
        this.broadcastLog(`[LFM REALTIME] Not delegating again (asked ${Math.round((Date.now() - prev.at) / 1000)} s ago): ${args.task}`);
        output = prev.result == null
          ? { status: 'already_running', note: 'This task is already running. Tell the user you are still on it; the answer arrives as a message.' }
          : { status: 'just_finished', result: String(prev.result).slice(0, 1500), note: 'This task just ran. Tell the user its result; do not run it again unless they ask again.' };
      } else if (name === `delegate_to_${this.targetAgent}`) {
        const task = String(args.task || '');
        const entry = { task, at: Date.now(), result: null };
        this.recentTasks.push(entry);
        this.broadcastLog(`[LFM REALTIME] Delegating to ${this.targetAgent.toUpperCase()}: ${task}`);
        this.delegations += 1;
        (async () => {
          let raw;
          try {
            raw = await this.delegateToAgent(task, this.targetAgent, true);
          } catch (e) {
            raw = `The agent failed: ${e.message}`;
          }
          this.delegations -= 1;
          entry.result = raw || 'Done.';
          const text = raw && raw.length > 5000 ? `${raw.substring(0, 5000)}... [TRUNCATED DUE TO LENGTH]` : raw;
          await sent;
          this.forSpeaker(() => this.deliverResult(task, text));
        })();
        output = { status: 'started', note: 'Running in the background. Tell the user in one short sentence that you are on it. The answer arrives later as a message; do not claim it is finished.' };
      } else {
        // After a reroute the model often shortens "heard": the first call's words are better.
        args = repairArgs(name, { ...args, heard: this.redirected && this.turnHeard ? this.turnHeard : args.heard });
        if (name === 'calendar_delete_event' && args.confirmed === true) {
          // The 2B model says confirmed=true on the first ask: only after the user was asked.
          const asked = this.pendingDelete && Date.now() - this.pendingDelete.at < 120_000 && sameTask(this.pendingDelete.event, args.event);
          if (!asked) args.confirmed = false;
        }
        if (name === 'calendar_delete_event' && args.confirmed !== true) this.pendingDelete = { event: String(args.event || ''), at: Date.now() };
        try {
          if (name === 'search_web') output = { result: await this.search(args.query) };
          else if (name === PHONE_ACTION_TOOL.name) output = { result: this.phoneBridge ? await this.phoneBridge.run(args) : 'Phone actions not available.' };
          else if (name === BUSINESS_TOOL.name) output = { result: this.business ? this.business.show({ focus: args.name || undefined }).spoken : 'The business dashboard is not available.' };
          else if (name === SHOW_CARD_TOOL.name) output = { result: (await this.showCard(args, { broadcast: this.broadcast })).result };
          else if (this.calendar?.isTool(name)) output = { result: await this.calendar.runTool(name, args) };
          else output = { error: `Unknown tool ${name}` };
        } catch (e) {
          output = { error: `${name} failed: ${e.message}` };
        }
      }
      return { call, output };
    }));

    if (!this.session) return outputsSent();
    for (const { call, output } of outputs) {
      if (this.session === session) {
        this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } });
      } else {
        // A reconnect in between: the call isn't in this session, so the result goes in as text.
        this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(Result of ${call.name}) ${JSON.stringify(output)}` }] } });
      }
    }
    this.request(redecide ? 'decide' : 'speak');
    outputsSent();
  }

  deliverResult(task, resultText) {
    this.active();
    if (!this.session) {
      console.log('[LFM REALTIME] No active session for agent answer (shown on screen only)');
      return;
    }
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(Agent result) The task "${task}" is finished. Agent answer:\n${resultText || 'Done.'}` }] },
    });
    this.request('speak');
  }

  sendUserText(text) {
    if (!this.session) return false;
    this.active();
    this.redirected = false;
    if (this.responding || this.audioPlaying()) this.interrupt();
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.remember('user', text);
    this.request('decide');
    return true;
  }

  /** The same task delegated less than REPEAT_TASK_MS ago, if any. */
  repeatOf(task) {
    const now = Date.now();
    this.recentTasks = this.recentTasks.filter((t) => now - t.at < REPEAT_TASK_MS);
    return this.recentTasks.find((t) => sameTask(t.task, task)) || null;
  }

  /** Talk happened: a Cloud session stays open CLOUD_IDLE_MS more. */
  active() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.cloud || !this.wanted) return;
    this.idleTimer = setTimeout(() => this.forSpeaker(() => this.park()), CLOUD_IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** Closes an idle Cloud session (Live stays on): the next words open it again. */
  park() {
    this.idleTimer = null;
    if (!this.session || !this.cloud) return;
    if (this.delegations > 0 || this.responding || this.speechActive || this.audioPlaying()) return this.active();
    console.log('[LFM] Idle: closing the Jarvis Cloud session until the user speaks');
    this.parked = true;
    const ws = this.ws;
    this.ws = null;
    this.session = null;
    this.warmedUp = null;
    this.endResponse();
    try { ws?.close(); } catch {}
  }

  disconnect() {
    this.wanted = false;
    this.parked = false;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retries = 0;
    this.dropped = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.pendingCommit = false;
    this.preroll = [];
    this.prerollBytes = 0;
    this.loudMs = 0;
    this.speechActive = false;
    this.silenceMs = 0;
    this.utteranceMs = 0;
    const ws = this.ws;
    this.ws = null;
    this.session = null;
    this.everOpened = false;
    this.warmedUp = null;
    this.connecting = false;
    this.playing = null;
    this.endResponse();
    if (ws) {
      console.log('[LFM] Closing Realtime session');
      this.broadcastLog('[LFM] Realtime Session Closing...');
      try { ws.close(); } catch {}
      this.broadcastAgentStatus(this.targetAgent || 'gemini', 'IDLE');
    }
  }
}
