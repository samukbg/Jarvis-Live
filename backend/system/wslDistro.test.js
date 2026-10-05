import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wslDistro, wslRoots } from './wslDistro.js';

test('JARVIS_WSL_DISTRO wins', () => {
  assert.equal(wslDistro({ env: { JARVIS_WSL_DISTRO: ' my-distro ' }, exists: () => true }), 'my-distro');
});

test('detects the distro that has avtr-1', () => {
  const exists = (p) => p.startsWith('\\\\wsl.localhost\\Ubuntu-24.04\\');
  assert.equal(wslDistro({ env: {}, exists }), 'Ubuntu-24.04');
});

test('falls back to Ubuntu', () => {
  assert.equal(wslDistro({ env: {}, exists: () => false }), 'Ubuntu');
  assert.deepEqual(wslRoots('Ubuntu'), ['\\\\wsl.localhost\\Ubuntu', '\\\\wsl$\\Ubuntu']);
});
