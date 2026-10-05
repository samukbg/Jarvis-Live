// node --test --experimental-strip-types src/server/serverConnection.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost, resolveServer, ServerUnavailableError, wsUrlFor } from './serverConnection.ts';

test('normalizeHost: protocols, LAN defaults, /ws suffix', () => {
  assert.equal(normalizeHost('jarvis.example.com/'), 'https://jarvis.example.com');
  assert.equal(normalizeHost('192.168.1.5:4000'), 'http://192.168.1.5:4000');
  assert.equal(normalizeHost('wss://x.example/ws'), 'https://x.example');
  assert.equal(normalizeHost('ws://localhost:4000/ws/'), 'http://localhost:4000');
  assert.equal(normalizeHost('  '), '');
  assert.equal(wsUrlFor('https://x.example'), 'wss://x.example/ws');
});

test('needs a URL and a key', async () => {
  await assert.rejects(resolveServer({ hostUrl: '', apiKey: '' }), ServerUnavailableError);
  await assert.rejects(resolveServer({ hostUrl: 'a.example', apiKey: '' }), /API key/);
  assert.deepEqual(await resolveServer({ hostUrl: 'a.example', apiKey: 'k' }), { url: 'https://a.example', key: 'k', name: 'a.example' });
});
