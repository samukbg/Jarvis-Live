import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpenAIRealtimeProvider, realtimeInstruction, realtimeTools, toJsonSchema } from './OpenAIRealtimeProvider.js';

/** A Realtime socket: records what Jarvis sends, lets the test play OpenAI's events. */
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
  close() { this.readyState = 3; }
  server(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  types() { return this.sent.map((e) => e.type); }
}

const tick = () => new Promise((r) => setImmediate(r));

function provider(over = {}) {
  const out = { messages: [], notes: [], audio: [] };
  const p = new OpenAIRealtimeProvider({
    apiKey: () => 'sk-test',
    WebSocketImpl: FakeSocket,
    broadcast: (m) => out.messages.push(m),
    broadcastAudioChunk: (b) => out.audio.push(b),
    broadcastLog() {},
    broadcastNotification: (n) => out.notes.push(n),
    broadcastAgentStatus() {},
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

test('tools: Gemini schemas become JSON Schema; web search and the agent are declared', () => {
  assert.deepEqual(toJsonSchema({ type: 'OBJECT', properties: { a: { type: 'STRING', enum: ['x'] }, n: { type: 'NUMBER' } } }),
    { type: 'object', properties: { a: { type: 'string', enum: ['x'] }, n: { type: 'number' } } });
  assert.deepEqual(toJsonSchema({ type: 'OBJECT' }), { type: 'object', properties: {} });
  const tools = realtimeTools('agy');
  assert.deepEqual(tools.map((t) => t.name), ['search_web', 'delegate_to_agy', 'phone_action', 'show_business_dashboard', 'show_card']);
  assert.ok(tools.every((t) => t.type === 'function' && t.parameters.type === 'object'));
  assert.equal(tools.find((t) => t.name === 'show_card').parameters.properties.temperature.type, 'number');
  const rules = realtimeInstruction('agy');
  assert.match(rules, /call `search_web` and answer yourself/);
  assert.match(rules, /\(Agent result\)/);
  assert.doesNotMatch(rules, /Google Search/);
});

test('connects with the key and configures 24 kHz PCM audio, the voice, VAD and tools', async () => {
  const { ws } = await connected();
  assert.match(ws.url, /^wss:\/\/api\.openai\.com\/v1\/realtime\?model=gpt-realtime-2\.1-mini$/);
  assert.equal(ws.opts.headers.Authorization, 'Bearer sk-test');
  const s = ws.sent[0].session;
  assert.equal(ws.sent[0].type, 'session.update');
  assert.equal(s.type, 'realtime');
  assert.deepEqual(s.output_modalities, ['audio']);
  assert.deepEqual(s.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.deepEqual(s.audio.output.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(s.audio.output.voice, 'marin');
  assert.equal(s.audio.input.turn_detection.interrupt_response, true);
  assert.equal(s.tools.length, 5);
});

test('no key: says where to add it, no connection', async () => {
  const { p, out } = provider({ apiKey: () => '' });
  FakeSocket.last = null;
  await p.connect('agy');
  assert.equal(FakeSocket.last, null);
  assert.match(out.notes[0].msg, /OpenAI API key in Settings → Voice/);
  assert.equal(p.sendAudio(Buffer.alloc(10)), false);
});

test('mic audio said while connecting is held, then sent once the session opens', async () => {
  const { p } = provider();
  await p.connect('agy');
  const ws = FakeSocket.last;
  assert.equal(p.sendAudio(Buffer.from([1, 2, 3, 4])), true);
  assert.equal(ws.sent.length, 0);
  ws.open();
  assert.deepEqual(ws.types(), ['session.update', 'input_audio_buffer.append']);
  assert.equal(ws.sent[1].audio, Buffer.from([1, 2, 3, 4]).toString('base64'));
  p.sendAudio(Buffer.from([5, 6]));
  assert.equal(ws.sent.at(-1).audio, Buffer.from([5, 6]).toString('base64'));
});

test('reply audio and transcript reach the apps like Gemini’s; the user talking over it interrupts', async () => {
  const { ws, out } = await connected();
  const pcm = Buffer.alloc(4800).toString('base64'); // 100 ms
  ws.server({ type: 'response.created', response: {} });
  ws.server({ type: 'response.output_audio.delta', item_id: 'it1', content_index: 0, delta: pcm });
  ws.server({ type: 'response.output_audio_transcript.delta', delta: 'Sunny in Paris.' });
  assert.equal(out.audio.length, 1);
  assert.ok(out.messages.some((m) => m.type === 'tts_chunk' && m.isPcm && m.format === 'pcm' && m.content === pcm));
  assert.ok(out.messages.some((m) => m.type === 'agent_status' && m.status === 'THINKING' && m.voice));
  ws.server({ type: 'input_audio_buffer.speech_started' });
  assert.ok(out.messages.some((m) => m.type === 'gemini_live_interrupt'));
  const cut = ws.sent.find((e) => e.type === 'conversation.item.truncate');
  assert.equal(cut.item_id, 'it1');
  assert.ok(cut.audio_end_ms < 100);
});

test('a finished reply is shown as final and remembered for a reconnect', async () => {
  const { p, ws, out } = await connected();
  ws.server({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Weather in Paris?' });
  ws.server({ type: 'response.created', response: {} });
  ws.server({ type: 'response.output_audio_transcript.delta', delta: 'Twelve degrees.' });
  ws.server({ type: 'response.done', response: { status: 'completed', output: [] } });
  assert.ok(out.messages.some((m) => m.type === 'voice_transcript' && m.is_final && m.text === 'Twelve degrees.'));
  // Dropped: the next session gets the conversation in its instructions, quietly.
  ws.emit('close', 1006, Buffer.from(''));
  await new Promise((r) => setTimeout(r, 20));
  const again = FakeSocket.last;
  assert.notEqual(again, ws);
  again.open();
  again.server({ type: 'session.created', session: {} });
  assert.match(again.sent[0].session.instructions, /User: Weather in Paris\?\nJarvis: Twelve degrees\./);
  assert.equal(out.notes.filter((n) => n.kind === 'success').length, 1, 'no second "connected" notice');
  p.disconnect();
});

test('search_web: answered by the search, then Jarvis speaks it', async () => {
  const queries = [];
  const { ws } = await connected({ search: async (q) => { queries.push(q); return 'Paris: 12°C, sunny.'; } });
  ws.server({ type: 'response.created', response: {} });
  ws.server({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name: 'search_web', call_id: 'c1', arguments: '{"query":"weather Paris"}' }] } });
  await tick();
  assert.deepEqual(queries, ['weather Paris']);
  const outItem = ws.sent.find((e) => e.type === 'conversation.item.create' && e.item.type === 'function_call_output');
  assert.equal(outItem.item.call_id, 'c1');
  assert.match(outItem.item.output, /12°C/);
  assert.equal(ws.types().at(-1), 'response.create');
});

test('delegation: "started" at once (no second acknowledgement after a spoken one), the answer spoken later', async () => {
  let finish;
  const { ws } = await connected({ delegateToAgent: () => new Promise((r) => { finish = r; }) });
  ws.server({ type: 'response.created', response: {} });
  ws.server({ type: 'response.output_audio.delta', item_id: 'a', delta: Buffer.alloc(48).toString('base64') });
  ws.server({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name: 'delegate_to_agy', call_id: 'd1', arguments: '{"task":"open Spotify"}' }] } });
  await tick();
  const started = ws.sent.find((e) => e.item?.type === 'function_call_output');
  assert.match(started.item.output, /started/);
  assert.ok(!ws.types().includes('response.create'), 'it already said it was on it');
  finish('Spotify is open.');
  await tick();
  const result = ws.sent.find((e) => e.item?.type === 'message' && /Agent result/.test(e.item.content[0].text));
  assert.match(result.item.content[0].text, /open Spotify[\s\S]*Spotify is open\./);
  assert.equal(ws.types().at(-1), 'response.create');
});

test('one response at a time: an answer arriving mid-reply waits for it to end', async () => {
  const { p, ws } = await connected();
  ws.server({ type: 'response.created', response: {} });
  p.deliverResult('task', 'done');
  assert.ok(!ws.types().includes('response.create'));
  ws.server({ type: 'response.done', response: { status: 'completed', output: [] } });
  assert.equal(ws.types().at(-1), 'response.create');
});

test('typed / Apple speech text is answered, with the latest camera frame', async () => {
  const { p, ws } = await connected();
  p.sendImage('image/jpeg', 'AAAA');
  assert.equal(p.sendUserText('What am I holding?'), true);
  const item = ws.sent.find((e) => e.type === 'conversation.item.create');
  assert.deepEqual(item.item.content.map((c) => c.type), ['input_image', 'input_text']);
  assert.equal(item.item.content[0].image_url, 'data:image/jpeg;base64,AAAA');
  assert.equal(ws.types().at(-1), 'response.create');
  p.disconnect();
  assert.equal(p.sendUserText('x'), false);
});

test('a key OpenAI refuses after the socket opens: no "connected", one warning, no retry', async () => {
  const { p, out } = provider();
  await p.connect('agy');
  const ws = FakeSocket.last;
  ws.open();
  ws.server({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided' } });
  ws.emit('close', 3000, Buffer.from('invalid_request_error.invalid_api_key'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeSocket.last, ws);
  assert.deepEqual(out.notes.map((n) => n.kind), ['warn']);
  assert.match(out.notes[0].msg, /OpenAI API key was refused/);
  assert.equal(p.wanted, false);
});

test('a refused key is reported once and not retried', async () => {
  const { p, out } = provider();
  await p.connect('agy');
  const ws = FakeSocket.last;
  ws.emit('error', new Error('Unexpected server response: 401'));
  ws.emit('close', 1006, Buffer.from(''));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeSocket.last, ws, 'no reconnect');
  assert.match(out.notes.at(-1).msg, /OpenAI API key was refused/);
  assert.equal(p.wanted, false);
});
