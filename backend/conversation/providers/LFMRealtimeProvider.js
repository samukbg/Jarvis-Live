// The orb's live voice through Liquid AI's LFM3-Audio Realtime model (running locally via
// llama.cpp on port 9931, or on Jarvis Cloud GPU machines when cloud-linked).
// Default option (1st priority) ahead of Gemini Live (2nd) and OpenAI Realtime (3rd).
//
// Protocol: OpenAI Realtime WebSocket compatible events.
// Audio input: converted from Jarvis 24 kHz s16 mono -> 16 kHz s16 mono expected by LFM3-Audio.
// Audio output: 24 kHz s16 mono played directly via broadcastAudioChunk + tts_chunk.
// Tools: search_web, delegate_to_${agent}, phone_action, show_card, business, calendar.
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PHONE_ACTION_TOOL } from '../../device/phoneActions.js';
import { BUSINESS_TOOL } from '../../business/card.js';
import { SHOW_CARD_TOOL, showCard } from '../../cards/showCard.js';
import { TranscriptBuffer } from '../transcript.js';
import { webSearch } from '../webSearch.js';
import { AGENT_LABELS, liveInstruction } from './GeminiLiveProvider.js';
import { CALENDAR_TOOLS } from '../../calendar/card.js';
import { realtimeTools, realtimeInstruction } from './OpenAIRealtimeProvider.js';

export const DEFAULT_LFM_MODEL = 'LFM3-Audio-2B-Q4_K_M.gguf';
export const DEFAULT_LOCAL_URL = 'ws://127.0.0.1:9931/v1/realtime';
export const DEFAULT_LOCAL_HTTP = 'http://127.0.0.1:9931';
const LABEL = 'LFM REALTIME';

// 24 kHz s16 mono = 48 bytes/ms; 16 kHz s16 mono = 32 bytes/ms.
const BYTES_PER_MS_24K = 48;
const BYTES_PER_MS_16K = 32;
const PENDING_AUDIO_BYTES = 24000 * 2 * 6; // 6 seconds
const RETRY_MS = [500, 1500, 3000, 5000];
const FRAME_MAX_AGE_MS = 15000;
const RESPONSE_START_MS = 20000;
const HISTORY_TURNS = 6;

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

export class LFMRealtimeProvider {
  constructor(options = {}) {
    this.cloudLink = options.cloudLink || null;
    this.urlGetter = options.url || (() => process.env.LFM_REALTIME_URL || DEFAULT_LOCAL_URL);
    this.modelGetter = options.model || (() => process.env.LFM_MODEL || DEFAULT_LFM_MODEL);
    this.voiceGetter = options.voice || (() => process.env.LFM_VOICE || 'female');
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
    this.fallbackToGemini = options.fallbackToGemini || null;

    // VAD tuning
    this.vadThreshold = Number(process.env.LFM_VAD_THRESHOLD) || 350;
    this.silenceDurationMs = Number(process.env.LFM_SILENCE_MS) || 500;

    this.ws = null;
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
    this.responding = false;
    this.wantResponse = false;
    this.responseTimer = null;
    this.responseAudio = false;
    this.speaking = false;
    this.playing = null;
    this.frame = null;
    this.sentFrame = null;

    // VAD state
    this.speechActive = false;
    this.silenceMs = 0;
    this.lastChunkAt = 0;
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

  /** One mic chunk (24 kHz s16 PCM): resampled to 16 kHz and sent or buffered. */
  sendAudio(pcm24k) {
    if (!pcm24k || pcm24k.length < 2) return false;

    // Convert 24k -> 16k
    const pcm16 = resample24kTo16k(pcm24k);
    if (!pcm16.length) return false;

    // Local VAD & barge-in detection
    const rms = calculateRms(pcm16);
    const chunkMs = Math.round(pcm16.length / BYTES_PER_MS_16K);

    if (rms >= this.vadThreshold) {
      this.silenceMs = 0;
      if (!this.speechActive) {
        this.speechActive = true;
        // User interrupted assistant speaking
        if (this.responding || this.audioPlaying()) {
          this.broadcast({ type: 'gemini_live_interrupt' });
          this.truncatePlayback();
          this.jarvisSpeech.flush();
          this.send({ type: 'response.cancel' });
        }
      }
    } else if (this.speechActive) {
      this.silenceMs += chunkMs;
      // Silence after speech: commit user turn and request assistant response
      if (this.silenceMs >= this.silenceDurationMs) {
        this.speechActive = false;
        this.silenceMs = 0;
        if (this.session) {
          this.send({ type: 'input_audio_buffer.commit' });
          this.requestResponse();
        }
      }
    }

    if (this.session) {
      return this.send({ type: 'input_audio_buffer.append', audio: pcm16.toString('base64') });
    }

    if (!this.wanted) return false;
    this.pendingAudio.push(pcm16);
    this.pendingBytes += pcm16.length;
    while (this.pendingBytes > PENDING_AUDIO_BYTES) this.pendingBytes -= this.pendingAudio.shift().length;
    if (!this.connecting && !this.retryTimer) this.connect(this.targetAgent);
    return true;
  }

  flushPendingAudio() {
    const chunks = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    for (const pcm16 of chunks) {
      if (!this.send({ type: 'input_audio_buffer.append', audio: pcm16.toString('base64') })) break;
    }
  }

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

  fail(message) {
    this.broadcastNotification({ label: LABEL, msg: message, kind: 'warn' });
    this.broadcastLog(`[LFM] ${message}`);
    this.disconnect();
    if (typeof this.fallbackToGemini === 'function') {
      this.broadcastLog('[LFM] Automatically activating Gemini Live fallback...');
      this.fallbackToGemini();
    }
  }

  /** Resolves the target WebSocket endpoint (Cloud machine if cloud-linked, else local). */
  async resolveEndpoint() {
    if (process.env.LFM_REALTIME_URL) return { url: process.env.LFM_REALTIME_URL, headers: {} };

    // 1. If linked to Jarvis Cloud, try to get a cloud voice session
    if (this.cloudLink && typeof this.cloudLink === 'function') {
      const link = this.cloudLink();
      if (link?.creds && typeof link.lfmVoiceEndpoint === 'function') {
        try {
          const ep = await link.lfmVoiceEndpoint();
          if (ep?.url) return { url: ep.url, headers: ep.token ? { Authorization: `Bearer ${ep.token}` } : {} };
        } catch (e) {
          console.warn('[LFM] Cloud endpoint retrieval error:', e.message);
        }
      }
    }

    // 2. Default to local llama serve endpoint
    return { url: this.urlGetter(), headers: {} };
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

    const { url, headers } = await this.resolveEndpoint();
    const model = this.modelGetter();
    console.log(`[LFM] Connecting to LFM Realtime at ${url}...`);
    this.broadcastLog(`[LFM] Initializing LFM Realtime Session (${url})...`);

    let ws;
    try {
      ws = new this.WebSocketImpl(url, { headers });
    } catch (e) {
      this.connecting = false;
      this.fail(`Connection failed: ${e.message}`);
      return;
    }
    this.ws = ws;

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
          instructions: realtimeInstruction(this.targetAgent, reconnect ? this.history : [], { calendar: this.calendar?.prompt() || null }),
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 16000 },
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: this.voiceGetter(),
            },
          },
          tools: realtimeTools(this.targetAgent, { calendar: !!this.calendar }),
          tool_choice: 'auto',
        },
      });

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
      const lastError = e?.message || String(e);
      console.error('[LFM] Error:', lastError);
      this.broadcastLog(`[LFM ERROR] ${lastError}`);
    });

    ws.on('close', (code, reason) => {
      const why = reason?.toString?.() || '';
      console.log(`[LFM] Realtime Session Closed — code:${code} reason:${why || 'none'}`);
      if (this.ws !== ws) return;
      this.ws = null;
      this.session = null;
      this.connecting = false;
      this.endResponse();
      if (!this.wanted) return;

      this.dropped = true;
      if (this.retries >= 3 && typeof this.fallbackToGemini === 'function') {
        this.fail('Local LFM server is not responding. Falling back to Gemini Live.');
        return;
      }
      this.scheduleReconnect();
    });
  }

  onEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        this.retries = 0;
        if (event.type === 'session.created') {
          console.log('[LFM] Realtime connected');
          this.broadcastLog('[LFM] Realtime Session Active ●');
          if (this.announce) this.broadcastNotification({ label: LABEL, msg: 'LFM Realtime voice connected', kind: 'success' });
          this.announce = false;
        }
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
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta': {
        const text = this.jarvisSpeech.add(event.delta || '');
        if (text) this.broadcast({ type: 'voice_transcript', text, role: 'assistant', is_final: false });
        break;
      }

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

  onAudio(event) {
    if (!event.delta) return;
    if (!this.speaking) {
      this.speaking = true;
      this.broadcast({ type: 'agent_status', agentId: this.targetAgent, status: 'THINKING', voice: true });
    }
    this.responseAudio = true;
    const pcm = Buffer.from(event.delta, 'base64');
    if (!this.playing || this.playing.itemId !== event.item_id) {
      this.playing = { itemId: event.item_id, contentIndex: event.content_index || 0, startedAt: Date.now(), ms: 0 };
    }
    this.playing.ms += pcm.length / BYTES_PER_MS_24K;
    this.broadcastAudioChunk(pcm);
    this.broadcast({ type: 'tts_chunk', content: event.delta, isPcm: true, format: 'pcm' });
  }

  audioPlaying() {
    return !!this.playing && Date.now() < this.playing.startedAt + this.playing.ms + 300;
  }

  truncatePlayback() {
    const p = this.playing;
    this.playing = null;
    if (!p?.itemId) return;
    const heard = Math.floor(Math.min(p.ms, Date.now() - p.startedAt));
    if (heard < p.ms) {
      this.send({ type: 'conversation.item.truncate', item_id: p.itemId, content_index: p.contentIndex, audio_end_ms: heard });
    }
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

    const calls = (response.output || []).filter((o) => o.type === 'function_call');
    if (calls.length) {
      this.runTools(calls, this.responseAudio);
    } else if (this.wantResponse) {
      this.wantResponse = false;
      this.requestResponse();
    }
  }

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
        this.broadcastLog(`[LFM REALTIME] Delegating to ${this.targetAgent.toUpperCase()}: ${task}`);
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
        output = { status: 'started', note: 'Running in background. The answer arrives later as a message; do not claim it is finished yet.' };
      } else {
        speak = true;
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

    if (!this.session) return;
    for (const { call, output } of outputs) {
      if (this.session === session) {
        this.send({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) },
        });
      } else {
        this.send({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(Result of ${call.name}) ${JSON.stringify(output)}` }] },
        });
        speak = true;
      }
    }
    if (speak || this.wantResponse) {
      this.wantResponse = false;
      this.requestResponse();
    }
  }

  deliverResult(task, resultText) {
    if (!this.session) {
      console.log('[LFM REALTIME] No active session for agent answer (shown on screen only)');
      return;
    }
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `(Agent result) The task "${task}" is finished. Agent answer:\n${resultText || 'Done.'}` }],
      },
    });
    this.requestResponse();
  }

  sendUserText(text) {
    if (!this.session) return false;
    if (this.responding) {
      this.send({ type: 'response.cancel' });
      this.broadcast({ type: 'gemini_live_interrupt' });
      this.truncatePlayback();
    }
    this.jarvisSpeech.flush();
    const image = this.freshFrame();
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [...(image ? [image] : []), { type: 'input_text', text }] },
    });
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
    this.speechActive = false;
    this.silenceMs = 0;
    const ws = this.ws;
    this.ws = null;
    this.session = null;
    this.connecting = false;
    this.playing = null;
    this.endResponse();
    if (ws) {
      console.log('[LFM] Closing Realtime session');
      this.broadcastLog('[LFM] Realtime Session Closing...');
      try { ws.close(); } catch {}
      if (this.broadcastAgentStatus) this.broadcastAgentStatus(this.targetAgent || 'gemini', 'IDLE');
    }
  }
}
