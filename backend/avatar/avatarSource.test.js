import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callbackUrl, createAvatarSource, lanAddress, normalizeSource } from './avatarSource.js';

test('normalize: the default streamer, or your own server by URL (+ optional key)', () => {
  assert.deepEqual(normalizeSource({ mode: 'cloud', url: 'ignored' }), { mode: 'cloud', url: '', key: '' });
  assert.deepEqual(normalizeSource({ mode: 'own', url: ' 192.168.1.20:7860/ ' }), { mode: 'own', url: 'http://192.168.1.20:7860', key: '' });
  assert.deepEqual(normalizeSource({ mode: 'own', url: 'gpu.example.com/api/avatar', key: ' k ' }), { mode: 'own', url: 'https://gpu.example.com', key: 'k' });
  assert.throws(() => normalizeSource({ mode: 'own', url: '' }), /URL/);
  assert.throws(() => normalizeSource({ mode: 'own', url: 'ftp://x' }), /URL/);
  assert.throws(() => normalizeSource({ mode: 'nope' }), /mode/);
});

test('saved in the data folder, private; defaults to the default streamer', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-avatar-')), 'avatar-source.json');
  const source = createAvatarSource({ file });
  assert.deepEqual(source.get(), { mode: 'cloud', url: '', key: '' });
  source.set({ mode: 'own', url: 'http://10.0.0.5:7860', key: 'secret' });
  assert.deepEqual(createAvatarSource({ file }).get(), { mode: 'own', url: 'http://10.0.0.5:7860', key: 'secret' }, 'survives a restart');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('the avatar calls this computer back where it can reach it', () => {
  const base = { port: 4000, lan: '192.168.1.42', tunnelUrl: 'https://me.trycloudflare.com' };
  assert.equal(callbackUrl({ ...base, target: 'http://127.0.0.1:7860' }), 'http://127.0.0.1:4000', 'same computer');
  assert.equal(callbackUrl({ ...base, target: 'http://192.168.1.20:7860' }), 'http://192.168.1.42:4000', 'same network: direct');
  assert.equal(callbackUrl({ ...base, target: 'https://gpu.example.com' }), 'https://me.trycloudflare.com', 'internet: through the tunnel');
  assert.equal(callbackUrl({ ...base, tunnelUrl: null, target: 'https://gpu.example.com' }), 'http://192.168.1.42:4000', 'no tunnel: best effort');
  assert.equal(callbackUrl({ ...base, envUrl: 'https://jarvis.me', target: 'http://192.168.1.20:7860' }), 'https://jarvis.me', 'JARVIS_BACKEND_URL wins');
});

test('LAN address: a private IPv4 that is not loopback', () => {
  const ifaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun3: [{ family: 'IPv4', address: '100.64.0.2', internal: false }],
    en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.42', internal: false }],
  };
  assert.equal(lanAddress(ifaces), '192.168.1.42');
  assert.equal(lanAddress({}), null);
});
