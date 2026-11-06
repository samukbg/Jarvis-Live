import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized, issueLocalCallbackKey } from './auth.js';

test('the API key works everywhere; a callback key only on the avatar-callback routes, until it expires', () => {
  const env = { API_KEY: 'k_real' };
  assert.equal(isAuthorized('k_real', env), true);
  assert.equal(isAuthorized('wrong', env), false);
  const key = issueLocalCallbackKey(60);
  assert.equal(isAuthorized(key, env, '/api/avatar/delegate'), true);
  assert.equal(isAuthorized(key, env, '/api/local-image'), false);
  assert.equal(isAuthorized(key, env), false, 'not the WebSocket');
  assert.equal(isAuthorized(issueLocalCallbackKey(1, Date.now() - 5_000), env, '/api/avatar/delegate'), false);
});
