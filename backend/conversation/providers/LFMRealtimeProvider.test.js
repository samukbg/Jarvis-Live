import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  LFMRealtimeProvider,
  resample24kTo16k,
  calculateRms,
  spokenText,
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
  last(type) { return this.sent.filter((e) => e.type === type).at(-1); }
  clear() { this.sent = []; }
}

const tick = () => new Promise((r) => setImmediate(r));
const loud = (ms) => { const b = Buffer.alloc(ms * 48); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? 2000 : -2000, i); return b; };
const quiet = (ms) => Buffer.alloc(ms * 48);

function provider(over = {}) {
  const out = { messages: [], notes: [], audio: [], logs: [], delegated: [], unavailable: [], sessions: [] };
  const p = new LFMRealtimeProvider({
    WebSocketImpl: FakeSocket,
    broadcast: (m) => out.messages.push(m),
    broadcastAudioChunk: (b) => out.audio.push(b),
    broadcastLog: (l) => out.logs.push(l),
    broadcastNotification: (n) => out.notes.push(n),
    delegateToAgent: async (task) => { out.delegated.push(task); return `Executed: ${task}`; },
    search: async (q) => `Search results for ${q}`,
    onUnavailable: (e) => out.unavailable.push(e.message),
    onSession: (s) => out.sessions.push(s),
    ...over,
  });
  return { p, out };
}

/** A provider with an open session whose warm-up is done. */
async function connected(over) {
  const r = provider(over);
  await r.p.connect('agy');
  const ws = FakeSocket.last;
  ws.open();
  ws.server({ type: 'session.updated', session: {} });
  ws.server({ type: 'response.done', response: { status: 'completed', output: [] } }); // warm-up
  ws.clear();
  return { ...r, ws };
}

const decision = (ws, output) => ws.server({ type: 'response.done', response: { status: 'completed', output } });
const call = (name, args = {}, id = 'c1') => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });

test('resample24kTo16k: exact 3:2 ratio with linear interpolation', () => {
  assert.equal(resample24kTo16k(null).length, 0);
  const inBuf = Buffer.alloc(6);
  inBuf.writeInt16LE(1000, 0);
  inBuf.writeInt16LE(2000, 2);
  inBuf.writeInt16LE(3000, 4);
  const outBuf = resample24kTo16k(inBuf);
  assert.equal(outBuf.length, 4);
  assert.equal(outBuf.readInt16LE(0), 1000);
  assert.equal(outBuf.readInt16LE(2), 2500);
});

test('calculateRms', () => {
  assert.equal(calculateRms(Buffer.alloc(0)), 0);
  const buf = Buffer.alloc(4);
  buf.writeInt16LE(300, 0);
  buf.writeInt16LE(400, 2);
  const rms = calculateRms(buf);
  assert.ok(rms > 350 && rms < 355);
});

test('spokenText drops <think> blocks, closed or not', () => {
  assert.equal(spokenText('<think>hmm</think> Hello there.'), 'Hello there.');
  assert.equal(spokenText('Hi.<think>still thinking'), 'Hi.');
});

test('session: text decisions with reply_directly + the tools, 16 kHz in, then a warm-up', async () => {
  const { p, out } = provider();
  await p.connect('agy');
  const ws = FakeSocket.last;
  assert.equal(ws.url, DEFAULT_LOCAL_URL);
  ws.open();
  const s = ws.sent[0].session;
  assert.deepEqual(s.output_modalities, ['text']);
  assert.equal(s.audio.input.format.rate, 16000);
  assert.equal(s.tools[0].name, 'reply_directly');
  assert.ok(s.tools.some((t) => t.name === 'delegate_to_agy'));
  assert.deepEqual(out.sessions, [{ cloud: false, remainingS: null }]);
  ws.server({ type: 'session.updated', session: {} });
  // Warm-up: a throwaway item and a 1-token text response.
  assert.deepEqual(ws.types().slice(1), ['conversation.item.create', 'response.create']);
  assert.equal(ws.last('response.create').response.max_output_tokens, 1);
  assert.ok(out.notes.some((n) => n.msg === 'LFM voice connected'));
});

test('the endpoint comes from options (Cloud): url, headers and remaining minutes', async () => {
  const { p, out } = provider({ endpoint: async () => ({ url: 'wss://gpu/api/voice/lfm/realtime', headers: { Authorization: 'Bearer t' }, cloud: true, remainingS: 600 }) });
  await p.connect('agy');
  assert.equal(FakeSocket.last.url, 'wss://gpu/api/voice/lfm/realtime');
  assert.equal(FakeSocket.last.opts.headers.Authorization, 'Bearer t');
  FakeSocket.last.open();
  assert.deepEqual(out.sessions, [{ cloud: true, remainingS: 600 }]);
});

test('no endpoint: onUnavailable is called with the reason', async () => {
  const { p, out } = provider({ endpoint: async () => { throw new Error('Downloading the voice model'); } });
  await p.connect('agy');
  assert.deepEqual(out.unavailable, ['Downloading the voice model']);
  assert.equal(p.wanted, false);
});

test('turns: only speech is sent (with a lead-in); silence after it commits and asks for a text decision', async () => {
  const { p, ws } = await connected();
  for (let i = 0; i < 10; i++) p.sendAudio(quiet(40));
  assert.equal(ws.sent.length, 0); // silence stays here
  p.sendAudio(loud(80));
  p.sendAudio(loud(80));
  assert.equal(ws.sent[0].type, 'input_audio_buffer.clear');
  assert.ok(ws.types().filter((t) => t === 'input_audio_buffer.append').length >= 3); // lead-in + speech
  for (let i = 0; i < 6; i++) p.sendAudio(loud(40));
  for (let i = 0; i < 16; i++) p.sendAudio(quiet(40));
  const types = ws.types();
  assert.ok(types.includes('input_audio_buffer.commit'));
  const rc = ws.last('response.create');
  assert.deepEqual(rc.response.output_modalities, ['text']);
});

test('a click (too short) is dropped, not committed', async () => {
  const { p, ws } = await connected();
  p.sendAudio(loud(130));
  for (let i = 0; i < 16; i++) p.sendAudio(quiet(40));
  assert.ok(!ws.types().includes('input_audio_buffer.commit'));
  assert.equal(ws.last('input_audio_buffer.clear') !== undefined, true);
});

test('reply_directly: a function output, then a spoken (text + audio) response', async () => {
  const { p, ws, out } = await connected();
  p.sendUserText('How are you?');
  ws.clear();
  decision(ws, [call('reply_directly')]);
  await tick();
  assert.equal(ws.sent[0].item.type, 'function_call_output');
  assert.deepEqual(ws.last('response.create').response.output_modalities, ['text', 'audio']);
  // The spoken reply: words as output_text, audio deltas played.
  ws.server({ type: 'response.output_text.delta', delta: "I'm great" });
  ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(480).toString('base64'), item_id: 'i1' });
  ws.server({ type: 'response.output_text.delta', delta: ', thanks!' });
  ws.server({ type: 'response.done', response: { status: 'completed', output: [] } });
  assert.equal(out.audio.length, 1);
  assert.ok(out.messages.some((m) => m.type === 'tts_chunk'));
  const final = out.messages.find((m) => m.type === 'voice_transcript' && m.is_final);
  assert.equal(final.text, "I'm great, thanks!");
});

test('a plain text answer in a decision is stopped and spoken after a nudge', async () => {
  const { p, ws } = await connected();
  p.sendUserText('Thanks!');
  ws.clear();
  ws.server({ type: 'response.output_item.added', item: { type: 'message' } });
  assert.equal(ws.sent[0].type, 'response.cancel');
  ws.server({ type: 'response.done', response: { status: 'cancelled', output: [{ type: 'message' }] } });
  assert.equal(ws.last('conversation.item.create').item.role, 'user');
  assert.deepEqual(ws.last('response.create').response.output_modalities, ['text', 'audio']);
});

test('delegation: started at once, acknowledged out loud, the result spoken later', async () => {
  const { p, ws, out } = await connected();
  p.sendUserText('Open Spotify');
  ws.clear();
  decision(ws, [call('delegate_to_agy', { task: 'Open Spotify' })]);
  await tick();
  assert.deepEqual(out.delegated, ['Open Spotify']);
  const fo = JSON.parse(ws.sent.find((e) => e.item?.type === 'function_call_output').item.output);
  assert.equal(fo.status, 'started');
  assert.deepEqual(ws.last('response.create').response.output_modalities, ['text', 'audio']);
  // The ack finishes, then the agent's answer comes in.
  ws.server({ type: 'response.done', response: { status: 'completed', output: [] } });
  await tick();
  await tick();
  const result = ws.sent.filter((e) => e.type === 'conversation.item.create').at(-1);
  assert.match(result.item.content[0].text, /^\(Agent result\)/);
  assert.deepEqual(ws.last('response.create').response.output_modalities, ['text', 'audio']);
});

test('tools: show_card and search_web results go back, then a spoken answer', async () => {
  const shown = [];
  const { p, ws } = await connected({ showCard: async (a) => { shown.push(a); return { result: 'Paris 14°C' }; } });
  p.sendUserText('Weather in Paris?');
  ws.clear();
  decision(ws, [call('show_card', { kind: 'weather', place: 'Paris' })]);
  await tick();
  await tick();
  assert.equal(shown[0].place, 'Paris');
  assert.match(ws.sent.find((e) => e.item?.type === 'function_call_output').item.output, /Paris 14/);
  assert.deepEqual(ws.last('response.create').response.output_modalities, ['text', 'audio']);
});

test('barge-in: speech during a spoken reply interrupts it; a decision is only cancelled', async () => {
  const { p, ws, out } = await connected();
  p.sendUserText('Tell me a story');
  decision(ws, [call('reply_directly')]);
  await tick();
  ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(48000).toString('base64'), item_id: 'i1' });
  ws.clear();
  for (let i = 0; i < 5; i++) p.sendAudio(loud(80)); // 400 ms of clear speech
  assert.ok(out.messages.some((m) => m.type === 'gemini_live_interrupt'));
  assert.ok(ws.types().includes('response.cancel'));

  const b = await connected();
  b.p.sendUserText('Open');
  b.ws.clear();
  b.p.sendAudio(loud(80));
  b.p.sendAudio(loud(80));
  assert.ok(b.ws.types().includes('response.cancel'));
  assert.ok(!b.out.messages.some((m) => m.type === 'gemini_live_interrupt'));
  // The cancelled decision's tool call never runs.
  decision(b.ws, [call('delegate_to_agy', { task: 'Open' })]);
  await tick();
  assert.deepEqual(b.out.delegated, []);
});

test('every response has an output cap (the server keeps generating after a disconnect)', async () => {
  const { p, ws } = await connected();
  p.sendUserText('Hi');
  decision(ws, [call('reply_directly')]);
  await tick();
  for (const rc of ws.sent.filter((e) => e.type === 'response.create')) assert.ok(rc.response.max_output_tokens > 0);
});

test('a second request while one runs is queued, a new user turn wins over a pending reply', async () => {
  const { p, ws } = await connected();
  p.sendUserText('one');
  p.sendUserText('two');
  assert.equal(ws.sent.filter((e) => e.type === 'response.create').length, 1);
  decision(ws, [call('reply_directly')]); // cancelled by 'two' → dropped, 'two' is decided
  await tick();
  const rc = ws.sent.filter((e) => e.type === 'response.create');
  assert.equal(rc.length, 2);
  assert.deepEqual(rc[1].response.output_modalities, ['text']);
});

test('images are not sent (no vision)', async () => {
  const { p, ws } = await connected();
  p.sendImage('image/jpeg', 'AAAA');
  p.sendUserText('What do you see?');
  assert.ok(!JSON.stringify(ws.sent).includes('input_image'));
});

test('a server never reached: one quick retry, then unavailable', async () => {
  const { p, out } = provider();
  await p.connect('agy');
  FakeSocket.last.emit('close', 1006, '');
  assert.equal(out.unavailable.length, 0);
  clearTimeout(p.retryTimer);
  p.retryTimer = null;
  await p.connect('agy');
  FakeSocket.last.emit('close', 1006, '');
  assert.equal(out.unavailable.length, 1);
});

test('a dropped session reconnects; after the retries it gives up and reports unavailable', async () => {
  const { p, out } = provider();
  await p.connect('agy');
  FakeSocket.last.open();
  for (let i = 0; i < 4; i++) {
    const ws = FakeSocket.last;
    ws.emit('close', 1006, '');
    clearTimeout(p.retryTimer);
    p.retryTimer = null;
    if (i < 3) await p.connect('agy');
  }
  assert.equal(out.unavailable.length, 1);
  assert.equal(p.wanted, false);
});

test('a Cloud session that ends (1008, token over) connects again for a new token', async () => {
  let asked = 0;
  const { p, out } = provider({ endpoint: async () => { asked += 1; return { url: 'wss://gpu/x', cloud: true }; } });
  await p.connect('agy');
  FakeSocket.last.open();
  FakeSocket.last.emit('close', 1008, 'Jarvis Cloud voice session expired');
  clearTimeout(p.retryTimer);
  p.retryTimer = null;
  await p.connect('agy');
  assert.equal(asked, 2);
  assert.deepEqual(out.unavailable, []);
});

test('an idle Cloud session is closed (Live stays on) and opens again when the user speaks', async () => {
  const { p, ws } = await connected({ endpoint: async () => ({ url: 'wss://gpu/x', cloud: true }) });
  p.park();
  assert.equal(p.session, null);
  assert.equal(p.parked, true);
  assert.equal(ws.readyState, 3);
  const before = FakeSocket.last;
  for (let i = 0; i < 10; i++) p.sendAudio(quiet(40)); // silence doesn't reconnect
  assert.equal(FakeSocket.last, before);
  p.sendAudio(loud(80));
  p.sendAudio(loud(80));
  await tick();
  assert.notEqual(FakeSocket.last, before); // speech does
  assert.equal(p.parked, false);
});

test('a Cloud session is not parked while an agent task is running', async () => {
  let finish;
  const { p, ws } = await connected({
    endpoint: async () => ({ url: 'wss://gpu/x', cloud: true }),
    delegateToAgent: () => new Promise((r) => { finish = r; }),
  });
  p.sendUserText('Open Spotify');
  decision(ws, [call('delegate_to_agy', { task: 'Open Spotify' })]);
  await tick();
  ws.server({ type: 'response.done', response: { status: 'completed', output: [] } });
  p.park();
  assert.ok(p.session);
  finish('done');
});

test('a local session is never parked', async () => {
  const { p } = await connected();
  p.park();
  assert.ok(p.session);
});

test('the same task asked again within 90 s is not delegated twice (echo / retry loops)', async () => {
  const { p, ws, out } = await connected({ delegateToAgent: async (t) => { out.delegated.push(t); return 'The agent failed: quota reached.'; } });
  p.sendUserText('Find flights to Lisbon');
  decision(ws, [call('delegate_to_agy', { task: 'Find cheap flights to Lisbon' })]);
  await tick();
  ws.server({ type: 'response.done', response: { status: 'completed', output: [] } });
  await tick(); await tick();
  ws.server({ type: 'response.done', response: { status: 'completed', output: [] } }); // the result, spoken
  p.sendUserText('find flights to lisbon');
  ws.clear();
  decision(ws, [call('delegate_to_agy', { task: 'Find flights to Lisbon now' }, 'c2')]);
  await tick();
  assert.equal(out.delegated.length, 1);
  const fo = JSON.parse(ws.sent.find((e) => e.item?.type === 'function_call_output').item.output);
  assert.equal(fo.status, 'just_finished');
  assert.match(fo.result, /quota/);
});

test('while Jarvis talks, quiet sound (its echo) is not a new turn; a clear voice still barges in', async () => {
  const { p, ws, out } = await connected();
  p.sendUserText('Tell me a story');
  decision(ws, [call('reply_directly')]);
  await tick();
  ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(48000 * 5).toString('base64'), item_id: 'i1' });
  ws.clear();
  const echo = (ms) => { const b = Buffer.alloc(ms * 48); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? 600 : -600, i); return b; };
  for (let i = 0; i < 20; i++) p.sendAudio(echo(40)); // RMS 600: speech normally, echo here
  assert.ok(!out.messages.some((m) => m.type === 'gemini_live_interrupt'));
  for (let i = 0; i < 10; i++) p.sendAudio(loud(40)); // RMS 2000 for 400 ms: the user
  assert.ok(out.messages.some((m) => m.type === 'gemini_live_interrupt'));
});

test('sameTask matches rewordings, not different tasks', async () => {
  const { sameTask } = await import('./LFMRealtimeProvider.js');
  assert.equal(sameTask('Find the current Bitcoin price', 'find bitcoin price now'), true);
  assert.equal(sameTask('Open Spotify and play jazz', 'Create a folder called invoices'), false);
});

test('a delegated timer / price is sent back once so the model calls the right tool', async () => {
  const { p, ws, out } = await connected();
  p.sendUserText('Set a timer for five minutes');
  ws.clear();
  decision(ws, [call('delegate_to_agy', { task: 'Set a timer for five minutes.' })]);
  await tick();
  assert.deepEqual(out.delegated, []);
  assert.match(ws.sent.find((e) => e.item?.type === 'function_call_output').item.output, /phone_action/);
  assert.deepEqual(ws.last('response.create').response.output_modalities, ['text']); // decide again
  // Delegated again in the same turn: it runs (no endless bounce).
  decision(ws, [call('delegate_to_agy', { task: 'Set a timer for five minutes.' }, 'c2')]);
  await tick();
  assert.deepEqual(out.delegated, ['Set a timer for five minutes.']);
});

test('misroutedTask', async () => {
  const { misroutedTask } = await import('./LFMRealtimeProvider.js');
  assert.equal(misroutedTask('Find the current Bitcoin price'), 'show_card');
  assert.equal(misroutedTask('Remind me to buy milk at 6 pm'), 'phone_action');
  assert.equal(misroutedTask("What's the weather in Lisbon"), 'show_card');
  assert.equal(misroutedTask('Open Spotify and play jazz'), null);
  assert.equal(misroutedTask('Write a script that tracks bitcoin prices into a CSV'), null);
});

test('every LFM tool asks for the words heard first; the rules come with worked examples', async () => {
  const { lfmTools, lfmInstructions } = await import('./LFMRealtimeProvider.js');
  for (const t of lfmTools('agy', { calendar: true })) {
    assert.deepEqual(Object.keys(t.parameters.properties)[0], 'heard', t.name);
    assert.ok(t.parameters.required.includes('heard'), t.name);
  }
  const text = lfmInstructions('agy', [], { calendar: 'CAL', now: Date.parse('2026-11-06T12:00:00') });
  assert.match(text, /phone_action \{"action":"timer","value":"600"\}/);
  assert.match(text, /calendar_update_event/);
  assert.match(text, /Today is Friday,? 6 November 2026/);
  // Not the shared prompt that sends weather and prices to a web search.
  assert.doesNotMatch(text, /Questions a web search can answer/);
  assert.doesNotMatch(lfmInstructions('agy', [], {}), /calendar_add_event/);
});

test('intentOf: clear requests map to their tool, computer work and ambiguity do not', async () => {
  const { intentOf } = await import('./LFMRealtimeProvider.js');
  const tool = (w, opts) => intentOf(w, 'agy', opts)?.tool ?? null;
  assert.equal(tool('Set a timer for five minutes'), 'phone_action');
  assert.equal(tool('Turn off Wi-Fi'), 'phone_action');
  assert.equal(tool('Call my mom'), 'phone_action');
  assert.equal(tool('Open WhatsApp on my phone'), 'phone_action');
  assert.equal(tool('Do I need an umbrella in Berlin today?'), 'show_card');
  assert.equal(tool('How much is Bitcoin right now?'), 'show_card');
  assert.equal(tool('How is Tesla stock doing today?'), 'show_card');
  assert.equal(tool("What's my computer's battery level?"), 'show_card');
  assert.equal(tool('Cancel my meeting with John tomorrow'), 'calendar_delete_event');
  assert.equal(tool('Move my dentist appointment to Thursday'), 'calendar_update_event');
  assert.equal(tool('Schedule a team meeting tomorrow at 10 am'), 'calendar_add_event');
  assert.equal(tool('Do I have any meetings today?'), 'calendar_agenda');
  assert.equal(tool('Add lunch with Ana to my calendar', { calendar: false }), null);
  assert.equal(tool('How is my business doing?'), 'show_business_dashboard');
  assert.equal(tool('Find the PDF I downloaded yesterday'), 'delegate_to_agy');
  assert.equal(tool('Write a Python script that sets an alarm'), 'delegate_to_agy');
  assert.equal(tool('Write a script that tracks bitcoin prices into a CSV'), 'delegate_to_agy');
  assert.equal(tool('Open Spotify and play jazz'), null);
  assert.equal(tool('Tell me a joke'), null);
  assert.equal(tool("What's the latest news about Apple?"), null);
});

test('rerouteFor: any tool (reply_directly too) is overruled by clear words, a right pick is not', async () => {
  const { rerouteFor } = await import('./LFMRealtimeProvider.js');
  assert.equal(rerouteFor('reply_directly', { heard: 'Set a timer for ten minutes' })?.tool, 'phone_action');
  assert.equal(rerouteFor('search_web', { heard: 'Will it rain tomorrow in London?', query: 'London weather' })?.tool, 'show_card');
  assert.equal(rerouteFor('search_web', { query: 'Bitcoin price' })?.tool, 'show_card');
  assert.equal(rerouteFor('delegate_to_agy', { task: 'Check the CPU and memory on my computer', heard: "How's my computer doing? Check the CPU and memory." })?.tool, 'show_card');
  assert.equal(rerouteFor('show_card', { heard: 'How much is Bitcoin?', kind: 'finance' }), null);
  assert.equal(rerouteFor('search_web', { heard: 'Who won the Champions League?' }), null);
});

test('repairArgs mends the 2B model\'s arguments from the user\'s words', async () => {
  const { repairArgs, dayFromWords } = await import('./LFMRealtimeProvider.js');
  const now = Date.parse('2026-11-06T12:00:00'); // a Friday
  assert.equal(dayFromWords('tomorrow at noon', now), '2026-11-07');
  assert.equal(dayFromWords('next Tuesday', now), '2026-11-10');
  assert.equal(dayFromWords('lunch', now), null);
  assert.deepEqual(repairArgs('calendar_update_event', { heard: 'Reschedule my call with Sara to tomorrow at noon.', event: 'Sara', start: '2026-11-11T12:00' }, { now }),
    { event: 'Sara', start: '2026-11-07T12:00' });
  assert.equal(repairArgs('calendar_add_event', { heard: 'Add lunch with Ana on Friday at 1 pm', title: 'Lunch', start: '2026-11-06T13:00' }, { now }).start, '2026-11-06T13:00');
  assert.equal(repairArgs('calendar_delete_event', { heard: 'Remove the yoga class from my calendar.', event: '' }).event, 'yoga class');
  assert.equal(repairArgs('calendar_delete_event', { heard: 'yoga class', event: '' }).event, 'yoga class');
  assert.equal(repairArgs('phone_action', { heard: 'Ring my brother.', action: 'call', target: '' }).target, 'my brother');
  assert.equal(repairArgs('phone_action', { heard: 'Take me to the nearest gas station.', action: 'navigate' }).target, 'the nearest gas station');
  assert.equal(repairArgs('phone_action', { heard: 'Play the next track.', action: 'music', value: 'play' }).value, 'next');
  assert.deepEqual(repairArgs('show_card', { heard: 'How much is Bitcoin right now?', kind: 'finance', summary: 'Current price of Bitcoin' }),
    { kind: 'finance', summary: 'Current price of Bitcoin', symbol: 'BTC', assetName: 'Bitcoin' });
  assert.equal(repairArgs('show_card', { heard: 'One euro in dollars?', kind: 'finance' }).symbol, 'EURUSD=X');
  const card = repairArgs('show_card', { heard: 'Will it rain tomorrow in New York?', kind: 'weather', summary: 'Provide the weather in New York' });
  assert.deepEqual(card, { kind: 'weather', summary: '', place: 'New York', day: 'tomorrow' });
});

test('a reroute works for every tool, and the turn\'s first words fill the second pick\'s arguments', async () => {
  const shown = [];
  const { p, ws } = await connected({ showCard: async (args) => { shown.push(args); return { result: 'Bitcoin is at 90,000 dollars.' }; } });
  p.sendUserText('How much is Bitcoin right now?');
  ws.clear();
  decision(ws, [call('reply_directly', { heard: 'How much is Bitcoin right now?' })]);
  await tick();
  assert.match(ws.sent.find((e) => e.item?.type === 'function_call_output').item.output, /show_card/);
  assert.deepEqual(ws.last('response.create').response.output_modalities, ['text']);
  ws.clear();
  decision(ws, [call('show_card', { heard: 'Bitcoin', kind: 'finance', symbol: 'BTC', summary: 'Provide the Bitcoin price' }, 'c2')]);
  await tick(); await tick();
  assert.deepEqual(shown, [{ kind: 'finance', symbol: 'BTC', summary: '' }]);
  assert.deepEqual(ws.last('response.create').response.output_modalities, ['text', 'audio']);
});

test('a calendar delete waits for the user to confirm, even when the model says confirmed=true', async () => {
  const runs = [];
  const calendar = { prompt: () => 'CAL', isTool: (n) => n.startsWith('calendar_'), runTool: async (n, a) => { runs.push(a); return a.confirmed ? 'Deleted.' : 'Not deleted yet. Ask the user to confirm.'; } };
  const { p, ws } = await connected({ calendar });
  p.sendUserText('Delete the team lunch');
  decision(ws, [call('calendar_delete_event', { heard: 'Delete the team lunch', event: 'team lunch', confirmed: true })]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs[0].confirmed, false);
  decision(ws, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Delete the team lunch on Friday?' }] }]); // spoken
  await tick();
  p.sendUserText('Yes');
  decision(ws, [call('calendar_delete_event', { heard: 'Yes', event: 'team lunch', confirmed: true }, 'c2')]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs[1].confirmed, true);
});
