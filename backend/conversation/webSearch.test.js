import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webSearch } from './webSearch.js';

const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('with a Gemini key: Gemini grounded on Google Search', async () => {
  const calls = [];
  const text = await webSearch('weather Paris', {
    geminiKey: 'g', openaiKey: 'sk-x',
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return reply({ candidates: [{ content: { parts: [{ text: 'Paris: 12°C, sunny.' }] } }] }); },
  });
  assert.equal(text, 'Paris: 12°C, sunny.');
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.deepEqual(calls[0].body.tools, [{ google_search: {} }]);
  assert.equal(calls[0].headers['x-goog-api-key'], 'g');
});

test('OpenAI key only: OpenAI web search', async () => {
  const calls = [];
  const text = await webSearch('BTC price', {
    geminiKey: '', openaiKey: 'sk-x',
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return reply({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Bitcoin is at $64,000.' }] }] }); },
  });
  assert.equal(text, 'Bitcoin is at $64,000.');
  assert.match(calls[0].url, /api\.openai\.com\/v1\/responses/);
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search' }]);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-x');
});

test('errors are explained; no key, no search', async () => {
  await assert.rejects(webSearch('x', { geminiKey: '', openaiKey: '' }), /No web search available/);
  await assert.rejects(webSearch('x', { geminiKey: 'g', fetchImpl: async () => reply({ error: { message: 'API key not valid' } }, false, 400) }), /API key not valid/);
  await assert.rejects(webSearch('  ', { geminiKey: 'g' }), /Nothing to search/);
});
