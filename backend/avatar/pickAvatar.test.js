import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAvatar } from './pickAvatar.js';

test('keeps an avatar the renderer has', () => {
  assert.equal(pickAvatar('Clara', ['alice', 'clara', 'maria']), 'clara');
});

test('missing avatar: default if present, else the first one (a server with one custom avatar)', () => {
  assert.equal(pickAvatar('ben', ['alice', 'maria']), 'maria');
  assert.equal(pickAvatar('maria', ['alice']), 'alice');
  assert.equal(pickAvatar('', ['alice']), 'alice');
});

test('unknown renderer list: keep what was asked', () => {
  assert.equal(pickAvatar('maria', null), 'maria');
  assert.equal(pickAvatar('', []), 'maria');
});
