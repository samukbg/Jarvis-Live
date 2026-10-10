import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiLiveProvider, liveInstruction, liveTools } from './GeminiLiveProvider.js';

test('Live answers web questions itself; the agent is non-blocking and announced out loud first', () => {
  const tools = liveTools('agy');
  assert.deepEqual(tools[0], { googleSearch: {} });
  const delegate = tools[1].functionDeclarations.find((d) => d.name === 'delegate_to_agy');
  assert.equal(delegate.behavior, 'NON_BLOCKING');
  assert.ok(tools[1].functionDeclarations.some((d) => d.name === 'phone_action'));
  const rules = liveInstruction('agy');
  assert.match(rules, /Google Search and answer yourself/);
  assert.match(rules, /ALWAYS speak first/);
  assert.match(rules, /I'm asking Antigravity/);
});

const provider = () => new GeminiLiveProvider({ broadcast() {}, broadcastLog() {}, broadcastNotification() {}, broadcastAgentStatus() {} });

test("the agent's answer goes back on the call that asked for it, spoken when Gemini is idle", () => {
  const p = provider();
  const sent = [];
  p.session = { sendToolResponse: (m) => sent.push(m) };
  p.deliverResult(p.session, { id: 'c1', name: 'delegate_to_agy' }, 'play jazz', 'Playing Kind of Blue.');
  const r = sent[0].functionResponses[0];
  assert.equal(r.id, 'c1');
  assert.equal(r.scheduling, 'WHEN_IDLE');
  assert.match(r.response.result, /Playing Kind of Blue/);
});

test('session replaced while the agent worked (1011): the answer arrives as a text turn, not lost', () => {
  const p = provider();
  const old = { sendToolResponse: () => assert.fail('old session') };
  const turns = [];
  p.session = { sendToolResponse: () => assert.fail('stale call id'), sendClientContent: (m) => turns.push(m) };
  p.deliverResult(old, { id: 'c1', name: 'delegate_to_agy' }, 'play jazz', 'Playing Kind of Blue.');
  assert.equal(turns.length, 1);
  assert.match(turns[0].turns[0].parts[0].text, /play jazz[\s\S]*Playing Kind of Blue/);
  p.session = null;
  p.deliverResult(old, { id: 'c2', name: 'delegate_to_agy' }, 'x', 'y'); // no session: no throw
});
