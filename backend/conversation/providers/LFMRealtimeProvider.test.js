import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  LFMRealtimeProvider,
  resample24kTo16k,
  calculateRms,
  DEFAULT_LOCAL_URL,
} from './LFMRealtimeProvider.js';

class FakeSocket extends EventEmitter {
  static last = null;
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
  }
  open() { this.readyState = 1; this.emit('open'); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit('close', 1000, 'normal'); }
  server(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  types() { return this.sent.map((e) => e.type); }
}

const tick = () => new Promise((r) => setImmediate(r));

function provider(over = {}) {
  const out = { messages: [], notes: [], audio: [], logs: [] };
  const p = new LFMRealtimeProvider({
    WebSocketImpl: FakeSocket,
    broadcast: (m) => out.messages.push(m),
    broadcastAudioChunk: (b) => out.audio.push(b),
    broadcastLog: (l) => out.logs.push(l),
    broadcastNotification: (n) => out.notes.push(n),
    broadcastAgentStatus: () => {},
    delegateToAgent: async (task) => `Executed: ${task}`,
    search: async (q) => `Search results for ${q}`,
    ...over,
  });
  return { p, out };
}

async function connected(over) {
  const r = provider(over);
  await r.p.connect('agy');
  FakeSocket.last.open();
  FakeSocket.last.server({ type: 'session.created', session: {} });
  return { ...r, ws: FakeSocket.last };
}

test('resample24kTo16k: resamples 24kHz 16-bit PCM to 16kHz with exact 3:2 ratio', () => {
  assert.equal(resample24kTo16k(null).length, 0);
  assert.equal(resample24kTo16k(Buffer.alloc(0)).length, 0);

  // 3 samples (6 bytes) of 24kHz -> 2 samples (4 bytes) of 16kHz
  const inBuf = Buffer.alloc(6);
  inBuf.writeInt16LE(1000, 0);
  inBuf.writeInt16LE(2000, 2);
  inBuf.writeInt16LE(3000, 4);

  const outBuf = resample24kTo16k(inBuf);
  assert.equal(outBuf.length, 4);
  assert.equal(outBuf.readInt16LE(0), 1000); // sample 0: srcIdx = 0
  assert.equal(outBuf.readInt16LE(2), 2500); // sample 1: srcIdx = 1.5, avg of 2000 and 3000
});

test('calculateRms: computes correct RMS energy for audio frames', () => {
  assert.equal(calculateRms(null), 0);
  assert.equal(calculateRms(Buffer.alloc(0)), 0);

  const buf = Buffer.alloc(4);
  buf.writeInt16LE(300, 0);
  buf.writeInt16LE(400, 2);
  // sqrt((90000 + 160000) / 2) = sqrt(125000) ≈ 353.55
  const rms = calculateRms(buf);
  assert.ok(rms > 350 && rms < 355);
});

test('connects and sends session.update with 16kHz input, 24kHz output, and tools', async () => {
  const { ws, out } = await connected();
  assert.equal(ws.url, DEFAULT_LOCAL_URL);
  assert.equal(ws.sent[0].type, 'session.update');
  const s = ws.sent[0].session;
  assert.equal(s.type, 'realtime');
  assert.equal(s.audio.input.format.rate, 16000);
  assert.equal(s.audio.output.format.rate, 24000);
  assert.ok(s.tools.length >= 4);
  assert.ok(s.tools.some((t) => t.name === 'delegate_to_agy'));
  assert.ok(out.notes.some((n) => n.msg.includes('LFM Realtime voice connected')));
});

test('buffers audio during connection, resamples 24k->16k, and flushes on connect', async () => {
  const { p } = provider();
  await p.connect('agy');
  const ws = FakeSocket.last;

  // 48 bytes at 24kHz = 1ms (24 samples) -> should resample to 32 bytes (16 samples)
  const chunk24k = Buffer.alloc(48);
  for (let i = 0; i < 24; i++) chunk24k.writeInt16LE(500, i * 2);

  assert.equal(p.sendAudio(chunk24k), true);
  assert.equal(ws.sent.length, 0); // Not sent yet because not open

  ws.open();
  assert.deepEqual(ws.types(), ['session.update', 'input_audio_buffer.append']);
  const app = ws.sent[1];
  const decoded = Buffer.from(app.audio, 'base64');
  assert.equal(decoded.length, 32); // Exact 16kHz resampled size
});

test('VAD: speech triggers speechActive; trailing silence commits turn and requests response', async () => {
  const { p, ws } = await connected();

  // Create loud frame (amplitude 1000, RMS 1000 > threshold 350)
  // 48 bytes = 24 samples @ 24k = 1ms -> resampled to 32 bytes = 16 samples @ 16k
  // To simulate 600ms of silence, we send silence chunks
  const loudChunk = Buffer.alloc(4800); // 100ms
  for (let i = 0; i < 2400; i++) loudChunk.writeInt16LE(1000, i * 2);

  p.sendAudio(loudChunk);
  assert.equal(p.speechActive, true);

  // Send silence chunks exceeding 500ms
  const silentChunk = Buffer.alloc(4800); // 100ms silence each
  for (let i = 0; i < 6; i++) {
    p.sendAudio(silentChunk);
  }

  assert.equal(p.speechActive, false);
  const types = ws.types();
  assert.ok(types.includes('input_audio_buffer.commit'));
  assert.ok(types.includes('response.create'));
});

test('barge-in: speech while responding sends response.cancel and gemini_live_interrupt', async () => {
  const { p, ws, out } = await connected();

  // Simulate assistant responding
  ws.server({ type: 'response.created' });
  assert.equal(p.responding, true);

  // User speaks loudly
  const loudChunk = Buffer.alloc(480);
  for (let i = 0; i < 240; i++) loudChunk.writeInt16LE(1500, i * 2);
  p.sendAudio(loudChunk);

  assert.ok(out.messages.some((m) => m.type === 'gemini_live_interrupt'));
  assert.ok(ws.types().includes('response.cancel'));
});

test('receives audio chunks and transcripts, sends status updates', async () => {
  const { ws, out } = await connected();

  const fakePcm24k = Buffer.from([10, 20, 30, 40]);
  ws.server({
    type: 'response.output_audio.delta',
    delta: fakePcm24k.toString('base64'),
    item_id: 'item_1',
  });

  assert.equal(out.audio.length, 1);
  assert.deepEqual(out.audio[0], fakePcm24k);
  assert.ok(out.messages.some((m) => m.type === 'tts_chunk' && m.content === fakePcm24k.toString('base64')));

  ws.server({
    type: 'response.output_audio_transcript.delta',
    delta: 'Hello there',
  });

  assert.ok(out.messages.some((m) => m.type === 'voice_transcript' && m.text.includes('Hello there')));

  ws.server({
    type: 'response.done',
    response: { output: [] },
  });

  assert.ok(out.messages.some((m) => m.type === 'agent_status' && m.status === 'IDLE'));
});

test('tool calling: executes delegate_to_agy in background and delivers result', async () => {
  const { ws } = await connected();

  ws.server({
    type: 'response.done',
    response: {
      output: [
        {
          type: 'function_call',
          call_id: 'call_123',
          name: 'delegate_to_agy',
          arguments: JSON.stringify({ task: 'Check system health' }),
        },
      ],
    },
  });

  await tick();
  // Sent start confirmation
  const fcOutput = ws.sent.find((e) => e.type === 'conversation.item.create' && e.item.call_id === 'call_123');
  assert.ok(fcOutput);
  assert.ok(fcOutput.item.output.includes('Running in background'));

  // Wait for background execution to deliver result
  await tick();
  const agentResult = ws.sent.find((e) => e.type === 'conversation.item.create' && e.item.content?.[0]?.text?.includes('Executed: Check system health'));
  assert.ok(agentResult);
});

test('tool calling: executes search_web and returns output', async () => {
  const { ws } = await connected();

  ws.server({
    type: 'response.done',
    response: {
      output: [
        {
          type: 'function_call',
          call_id: 'call_456',
          name: 'search_web',
          arguments: JSON.stringify({ query: 'weather tomorrow' }),
        },
      ],
    },
  });

  await tick();
  const searchOutput = ws.sent.find((e) => e.type === 'conversation.item.create' && e.item.call_id === 'call_456');
  assert.ok(searchOutput);
  assert.ok(searchOutput.item.output.includes('Search results for weather tomorrow'));
});

test('resolveEndpoint uses cloudLink when available', async () => {
  const cloudLink = () => ({
    creds: { token: 'cloud-token' },
    lfmVoiceEndpoint: async () => ({ url: 'wss://cloud.jarvis.example/v1/realtime', token: 'bearer-token' }),
  });

  const { p } = provider({ cloudLink });
  await p.connect('agy');
  const ws = FakeSocket.last;
  assert.equal(ws.url, 'wss://cloud.jarvis.example/v1/realtime');
  assert.equal(ws.opts.headers.Authorization, 'Bearer bearer-token');
});
