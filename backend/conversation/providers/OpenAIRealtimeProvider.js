// The orb's live voice through OpenAI Realtime (gpt-realtime-2.1-mini by default) — the second
// option next to Gemini Live (Settings → Voice), with the user's own OpenAI API key; never Jarvis
// Cloud. Same job and same messages to the apps as GeminiLiveProvider: mic PCM in (24 kHz s16),
// reply PCM out (24 kHz s16) as tts_chunk + AUDO, transcripts, interruptions, the same tools.
// Differences it bridges:
// - no built-in Google Search: a search_web tool (conversation/webSearch.js) answers instead;
// - a function call holds the turn until its output comes back: the agent delegation returns
//   "started" at once and its answer comes later as a message Jarvis is asked to speak;
// - no session resumption: a dropped session reconnects with the last turns in its instructions;
// - camera / screen frames are sent as one image when the user starts talking, not as a stream.
import WebSocket from 'ws';
import { PHONE_ACTION_TOOL } from '../../device/phoneActions.js';
import { BUSINESS_TOOL } from '../../business/card.js';
import { SHOW_CARD_TOOL, showCard } from '../../cards/showCard.js';
import { TranscriptBuffer } from '../transcript.js';
import { webSearch } from '../webSearch.js';
import { AGENT_LABELS, liveInstruction } from './GeminiLiveProvider.js';

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1-mini';
const DEFAULT_VOICE = 'marin';
const LABEL = 'OPENAI REALTIME';
// Mic audio held while a dropped session reconnects (24 kHz s16 mono: 6 s), then sent.
const PENDING_AUDIO_BYTES = 24000 * 2 * 6;
// Reconnect delays after a drop.
const RETRY_MS = [0, 500, 1500, 3000, 6000, 15000];
// 24 kHz s16 mono: bytes per millisecond of audio.
const BYTES_PER_MS = 48;
// A frame the user showed is sent with what they say if it is this recent.
const FRAME_MAX_AGE_MS = 5000;
// Turns carried into a reconnected session's instructions.
const HISTORY_TURNS = 12;
// response.create that never started (refused): stop waiting for it.
const RESPONSE_START_MS = 5000;
// Refused for good: say so instead of reconnecting forever.
const FATAL = /invalid_api_key|insufficient_quota|model_not_found|\b401\b|\b403\b|\b404\b|incorrect api key|billing/i;

/** Gemini's schema types (OBJECT, STRING…) as JSON Schema (object, string…). */
export function toJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

const fn = (tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: toJsonSchema(tool.parameters) });

/** The Realtime session's tools: web search, the agent (answer later), the phone, the dashboard, cards. */
export function realtimeTools(agent) {
  const name = AGENT_LABELS[agent] || agent.toUpperCase();
  return [
    {
      type: 'function',
      name: 'search_web',
      description: 'Searches the web and returns the facts to tell the user: weather, news, events, opening hours, prices, sports, facts, places.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for, with the place and day when they matter.' } }, required: ['query'] },
    },
    {
      type: 'function',
      name: `delegate_to_${agent}`,
      description: `Runs a task on the user's computer with the ${name} agent, in the background: apps, files, scripts, browsing, coding. It returns at once; the agent's answer arrives later as a message. Say a short acknowledgement as you call it.`,
      parameters: { type: 'object', properties: { task: { type: 'string', description: 'The detailed task instruction to send to the agent' } }, required: ['task'] },
    },
    fn(PHONE_ACTION_TOOL), fn(BUSINESS_TOOL), fn(SHOW_CARD_TOOL),
  ];
}

/** The rules (shared with Gemini), plus how agent answers arrive, plus the turns before a drop. */
export function realtimeInstruction(agent, history = []) {
  let text = `${liveInstruction(agent, { search: 'call `search_web`' })}

The agent's answers come back later as a message starting with "(Agent result)": tell the user what it says, briefly and naturally.`;
  if (history.length) {
    text += `\n\nThe conversation so far (the connection dropped; carry on from here without mentioning it):\n${history.map((h) => `${h.role === 'user' ? 'User' : 'Jarvis'}: ${h.text}`).join('\n')}`;
  }
  return text;
}

export class OpenAIRealtimeProvider {
  constructor(options) {
    this.apiKey = options.apiKey || (() => process.env.OPENAI_API_KEY);
    this.model = options.model || (() => process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL);
    this.voice = options.voice || (() => process.env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE);
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.search = options.search || webSearch;
    this.broadcast = options.broadcast;
    this.broadcastAudioChunk = options.broadcastAudioChunk || (() => {});
    this.broadcastLog = options.broadcastLog;
    this.broadcastNotification = options.broadcastNotification;
    this.broadcastAgentStatus = options.broadcastAgentStatus;
    this.delegateToAgent = options.delegateToAgent;
    this.phoneBridge = options.phoneBridge;
    this.business = options.business || null;
    this.showCard = options.showCard || showCard;
    this.forSpeaker = options.forSpeaker || ((fn) => fn());

    this.ws = null;
    // The open, configured socket (null while connecting or off): what the server checks.
    this.session = null;
    this.connecting = false;
    this.wanted = false;
    this.retries = 0;
    this.retryTimer = null;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.jarvisSpeech = new TranscriptBuffer();
    this.lastUserUtterance = '';
    this.history = [];
    this.dropped = false;
    // A response is being generated (one at a time); another was asked for meanwhile.
    this.responding = false;
    this.wantResponse = false;
    this.responseTimer = null;
    this.responseAudio = false;
    this.speaking = false;
    // The assistant audio being played: { itemId, contentIndex, startedAt, ms } (for barge-in).
    this.playing = null;
    this.frame = null;
    this.sentFrame = null;
  }

  send(event) {
    const ws = this.session || this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  /** One mic chunk (24 kHz s16 PCM): sent now, or held while the session (re)connects. */
  sendAudio(pcm) {
    if (this.session && this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })) return true;
    if (!this.wanted) return false;
    this.pendingAudio.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes > PENDING_AUDIO_BYTES) this.pendingBytes -= this.pendingAudio.shift().length;
    if (!this.connecting && !this.retryTimer) this.connect(this.targetAgent);
    return true;
  }

  flushPendingAudio() {
    const chunks = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    for (const pcm of chunks) if (!this.sendAudio(pcm)) break;
  }

  /** A camera / screen frame: kept, and sent with what the user says next. */
  sendImage(mimeType, data) {
    this.frame = { mimeType: mimeType || 'image/jpeg', data, at: Date.now() };
  }

  freshFrame() {
    const f = this.frame;
    if (!f || f === this.sentFrame || Date.now() - f.at > FRAME_MAX_AGE_MS) return null;
    this.sentFrame = f;
    return { type: 'input_image', image_url: `data:${f.mimeType};base64,${f.data}` };
  }

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

  /** Refused for good (bad key, no credit…): shown once, no reconnecting. */
  fail(message) {
    this.broadcastNotification({ label: LABEL, msg: message, kind: 'warn' });
    this.broadcastLog(`[OPENAI] ${message}`);
    this.disconnect();
  }

  async connect(targetAgent = 'agy') {
    if (this.connecting) return;
    if (this.session) {
      if (this.targetAgent === targetAgent) return;
      this.disconnect(); // other agent, other tools: a new conversation
      this.history = [];
    }
    const key = this.apiKey();
    if (!key) {
      this.wanted = false;
      this.broadcastNotification({ label: LABEL, msg: 'Add your OpenAI API key in Settings → Voice (or OPENAI_API_KEY in .env).', kind: 'warn' });
      return;
    }
    this.connecting = true;
    this.wanted = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.targetAgent = targetAgent;
    // After a drop: quiet, and the conversation carries on (its last turns go in the instructions).
    const reconnect = this.dropped;
    this.dropped = false;
    if (!reconnect) this.history = [];
    const model = this.model();
    console.log(`[OPENAI] Connecting to Realtime (${model})...`);
    this.broadcastLog('[OPENAI] Initializing Realtime Session...');

    let ws;
    try {
      ws = new this.WebSocketImpl(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` } });
    } catch (e) {
      this.connecting = false;
      this.fail(`Connection failed: ${e.message}`);
      return;
    }
    this.ws = ws;
    let lastError = '';

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.session = ws;
      this.connecting = false;
      this.responding = false;
      this.wantResponse = false;
      this.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          model,
          instructions: realtimeInstruction(this.targetAgent, reconnect ? this.history : []),
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              // What the user said, for the conversation carried over a drop (not shown on screen).
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true },
            },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: this.voice() },
          },
          tools: realtimeTools(this.targetAgent),
          tool_choice: 'auto',
        },
      });
      // "Connected" waits for OpenAI's session.created: a bad key only shows after the socket opens.
      this.announce = !reconnect;
      this.flushPendingAudio();
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      this.forSpeaker(() => this.onEvent(event));
    });

    ws.on('error', (e) => {
      lastError = e?.message || String(e);
      console.error('[OPENAI] Error:', lastError);
      this.broadcastLog(`[OPENAI ERROR] ${lastError}`);
    });

    ws.on('close', (code, reason) => {
      const why = reason?.toString?.() || '';
      console.log(`[OPENAI] Realtime Session Closed — code:${code} reason:${why || 'none'}`);
      if (this.ws !== ws) return;
      this.ws = null;
      this.session = null;
      this.connecting = false;
      this.endResponse();
      if (!this.wanted) return;
      if (FATAL.test(`${why} ${lastError}`)) {
        this.fail(/401|invalid_api_key|incorrect api key/i.test(`${why} ${lastError}`) ? 'Your OpenAI API key was refused — check it in Settings → Voice (or OPENAI_API_KEY in .env).' : (why || lastError));
        return;
      }
      this.dropped = true;
      this.scheduleReconnect();
    });
  }

  onEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        this.retries = 0;
        if (event.type === 'session.created') {
          console.log('[OPENAI] Realtime connected');
          this.broadcastLog('[OPENAI] Realtime Session Active ●');
          if (this.announce) this.broadcastNotification({ label: LABEL, msg: 'Live voice session connected', kind: 'success' });
          this.announce = false;
        }
        break;
      case 'input_audio_buffer.speech_started':
        // The user talks over Jarvis: the apps drop what's queued, OpenAI forgets the unheard rest.
        if (this.responding || this.audioPlaying()) {
          this.broadcast({ type: 'gemini_live_interrupt' });
          this.truncatePlayback();
          this.jarvisSpeech.flush();
        }
        {
          const image = this.freshFrame();
          if (image) this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [image] } });
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.lastUserUtterance = String(event.transcript || '').trim();
        this.remember('user', this.lastUserUtterance);
        break;
      case 'response.created':
        clearTimeout(this.responseTimer);
        this.responding = true;
        this.responseAudio = false;
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.onAudio(event);
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        const text = this.jarvisSpeech.add(event.delta || '');
        if (text) this.broadcast({ type: 'voice_transcript', text, role: 'assistant', is_final: false });
        break;
      }
      case 'response.done':
        this.onResponseDone(event.response || {});
        break;
      case 'error': {
        const err = event.error || {};
        if (err.code === 'conversation_already_has_active_response') {
          this.wantResponse = true;
          break;
        }
        console.error('[OPENAI] Server error:', err.code, err.message);
        this.broadcastLog(`[OPENAI ERROR] ${err.message || err.code}`);
        if (err.code === 'invalid_api_key') this.fail('Your OpenAI API key was refused — check it in Settings → Voice (or OPENAI_API_KEY in .env).');
        else if (FATAL.test(`${err.code} ${err.message}`)) this.fail(err.message || err.code);
        break;
      }
      default:
        break;
    }
  }

  onAudio(event) {
    if (!event.delta) return;
    if (!this.speaking) {
      this.speaking = true;
      // voice: Jarvis speaking, not an agent at work (the watch shows those as "Working with…").
      this.broadcast({ type: 'agent_status', agentId: this.targetAgent, status: 'THINKING', voice: true });
    }
    this.responseAudio = true;
    const pcm = Buffer.from(event.delta, 'base64');
    if (!this.playing || this.playing.itemId !== event.item_id) {
      this.playing = { itemId: event.item_id, contentIndex: event.content_index || 0, startedAt: Date.now(), ms: 0 };
    }
    this.playing.ms += pcm.length / BYTES_PER_MS;
    this.broadcastAudioChunk(pcm);
    this.broadcast({ type: 'tts_chunk', content: event.delta, isPcm: true, format: 'pcm' });
  }

  /** Is reply audio still playing on the apps (sent in real time from its first chunk)? */
  audioPlaying() {
    return !!this.playing && Date.now() < this.playing.startedAt + this.playing.ms + 300;
  }

  /** Cut the assistant's reply where the user stopped hearing it, so its transcript matches. */
  truncatePlayback() {
    const p = this.playing;
    this.playing = null;
    if (!p?.itemId) return;
    const heard = Math.floor(Math.min(p.ms, Date.now() - p.startedAt));
    if (heard < p.ms) this.send({ type: 'conversation.item.truncate', item_id: p.itemId, content_index: p.contentIndex, audio_end_ms: heard });
  }

  endResponse() {
    clearTimeout(this.responseTimer);
    this.responding = false;
    this.wantResponse = false;
    if (this.speaking) {
      this.speaking = false;
      this.broadcast({ type: 'agent_status', agentId: this.targetAgent, status: 'IDLE', voice: true });
    }
  }

  onResponseDone(response) {
    clearTimeout(this.responseTimer);
    this.responding = false;
    const said = this.jarvisSpeech.flush();
    if (said) {
      this.broadcast({ type: 'voice_transcript', text: said, role: 'assistant', is_final: true });
      this.remember('assistant', said);
    }
    if (this.speaking) {
      this.speaking = false;
      this.broadcast({ type: 'agent_status', agentId: this.targetAgent, status: 'IDLE', voice: true });
    }
    if (response.status === 'failed') {
      const err = response.status_details?.error;
      this.broadcastLog(`[OPENAI ERROR] Response failed: ${err?.message || err?.code || 'unknown'}`);
      if (err && FATAL.test(`${err.code} ${err.message}`)) {
        this.fail(err.message || err.code);
        return;
      }
    }
    const calls = (response.output || []).filter((o) => o.type === 'function_call');
    if (calls.length) this.runTools(calls, this.responseAudio);
    else if (this.wantResponse) {
      this.wantResponse = false;
      this.requestResponse();
    }
  }

  /** Asks for a reply now, or after the current one (one response at a time). */
  requestResponse() {
    if (!this.session) return;
    if (this.responding) {
      this.wantResponse = true;
      return;
    }
    if (!this.send({ type: 'response.create' })) return;
    this.responding = true;
    clearTimeout(this.responseTimer);
    this.responseTimer = setTimeout(() => { this.responding = false; }, RESPONSE_START_MS);
    this.responseTimer.unref?.();
  }

  /**
   * Runs the response's function calls, sends their outputs, and has Jarvis speak them. The agent
   * delegation answers "started" at once (Jarvis only speaks if it hadn't acknowledged yet); its
   * real answer comes later through deliverResult.
   */
  async runTools(calls, spoke) {
    const session = this.session;
    let speak = false;
    const outputs = await Promise.all(calls.map(async (call) => {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch {}
      const name = call.name;
      let output;
      if (name === `delegate_to_${this.targetAgent}`) {
        const task = String(args.task || '');
        this.broadcastLog(`[OPENAI REALTIME] Delegating to ${this.targetAgent.toUpperCase()}: ${task}`);
        (async () => {
          let raw;
          try {
            raw = await this.delegateToAgent(task, this.targetAgent, true);
          } catch (e) {
            raw = `The agent failed: ${e.message}`;
          }
          const text = raw && raw.length > 5000 ? `${raw.substring(0, 5000)}... [TRUNCATED DUE TO LENGTH]` : raw;
          this.deliverResult(task, text);
        })();
        if (!spoke) speak = true;
        output = { status: 'started', note: 'Running in the background. The answer arrives later as a message; do not say it is done yet.' };
      } else {
        speak = true;
        try {
          if (name === 'search_web') output = { result: await this.search(args.query) };
          else if (name === PHONE_ACTION_TOOL.name) output = { result: this.phoneBridge ? await this.phoneBridge.run(args) : 'Phone actions are not available.' };
          else if (name === BUSINESS_TOOL.name) output = { result: this.business ? this.business.show({ focus: args.name || undefined }).spoken : 'The business dashboard is not available on this Jarvis server.' };
          else if (name === SHOW_CARD_TOOL.name) output = { result: (await this.showCard(args, { broadcast: this.broadcast })).result };
          else output = { error: `Unknown tool ${name}` };
        } catch (e) {
          output = { error: `${name} failed: ${e.message}. Tell the user in words what you can.` };
        }
      }
      return { call, output };
    }));
    if (!this.session) return;
    for (const { call, output } of outputs) {
      if (this.session === session) {
        this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } });
      } else {
        // Reconnected meanwhile: the call id means nothing to the new session.
        this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(Result of ${call.name}) ${JSON.stringify(output)}` }] } });
        speak = true;
      }
    }
    if (speak || this.wantResponse) {
      this.wantResponse = false;
      this.requestResponse();
    }
  }

  /** The agent's answer: added to the conversation, and Jarvis tells the user once it is quiet. */
  deliverResult(task, resultText) {
    if (!this.session) {
      console.log('[OPENAI REALTIME] No Realtime session for the agent answer (shown on screen only)');
      return;
    }
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(Agent result) The task "${task}" is finished. Agent answer:\n${resultText || 'Done.'}` }] },
    });
    this.requestResponse();
  }

  /** A user turn as text (Apple speech, Siri): answered like speech. False when no session is open. */
  sendUserText(text) {
    if (!this.session) return false;
    if (this.responding) {
      this.send({ type: 'response.cancel' });
      this.broadcast({ type: 'gemini_live_interrupt' });
      this.truncatePlayback();
    }
    this.jarvisSpeech.flush();
    const image = this.freshFrame();
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [...(image ? [image] : []), { type: 'input_text', text }] } });
    this.lastUserUtterance = text;
    this.remember('user', text);
    this.requestResponse();
    return true;
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retries = 0;
    this.dropped = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    const ws = this.ws;
    this.ws = null;
    this.session = null;
    this.connecting = false;
    this.playing = null;
    this.endResponse();
    if (ws) {
      console.log('[OPENAI] Closing Realtime session');
      this.broadcastLog('[OPENAI] Realtime Session Closing...');
      try { ws.close(); } catch {}
      if (this.broadcastAgentStatus) this.broadcastAgentStatus(this.targetAgent || 'gemini', 'IDLE');
    }
  }
}
