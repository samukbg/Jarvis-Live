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
import { realtimeTools, realtimeInstruction } from './OpenAIRealtimeProvider.js';

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

/** Talking without a tool: in a text decision the 2B model always reaches for a tool, so it gets one. */
export const REPLY_TOOL = {
  type: 'function',
  name: 'reply_directly',
  description: 'Answer the user yourself, out loud, with no other tool: greetings, thanks, small talk, how you are, opinions, jokes, and general knowledge you already know (science, history, definitions, fun facts, advice).',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const lfmTools = (agent, opts) => [REPLY_TOOL, ...realtimeTools(agent, opts)];

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
    if (!this.session && !this.connecting && !this.retryTimer) this.connect(this.targetAgent);
    const pcm16 = resample24kTo16k(pcm24k);
    if (!pcm16.length) return false;
    const ms = pcm16.length / BYTES_PER_MS_16K;
    const loud = calculateRms(pcm16) >= this.vadThreshold;

    if (!this.speechActive) {
      this.preroll.push(pcm16);
      this.prerollBytes += pcm16.length;
      while (this.prerollBytes - this.preroll[0].length >= PREROLL_MS * BYTES_PER_MS_16K) this.prerollBytes -= this.preroll.shift().length;
      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.loudMs < MIN_SPEECH_MS) return true;
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
          instructions: realtimeInstruction(this.targetAgent, reconnect ? this.history : [], { calendar: this.calendar?.prompt() || null }),
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
    const outputs = await Promise.all(calls.map(async (call) => {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch {}
      const name = call.name;
      let output;

      if (name === REPLY_TOOL.name) {
        output = { ok: true, note: 'Answer the user now, out loud, in one or two short sentences.' };
      } else if (name === `delegate_to_${this.targetAgent}`) {
        const task = String(args.task || '');
        this.broadcastLog(`[LFM REALTIME] Delegating to ${this.targetAgent.toUpperCase()}: ${task}`);
        (async () => {
          let raw;
          try {
            raw = await this.delegateToAgent(task, this.targetAgent, true);
          } catch (e) {
            raw = `The agent failed: ${e.message}`;
          }
          const text = raw && raw.length > 5000 ? `${raw.substring(0, 5000)}... [TRUNCATED DUE TO LENGTH]` : raw;
          await sent;
          this.forSpeaker(() => this.deliverResult(task, text));
        })();
        output = { status: 'started', note: 'Running in the background. Tell the user in one short sentence that you are on it. The answer arrives later as a message; do not claim it is finished.' };
      } else {
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
    this.request('speak');
    outputsSent();
  }

  deliverResult(task, resultText) {
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
    if (this.responding || this.audioPlaying()) this.interrupt();
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.remember('user', text);
    this.request('decide');
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
