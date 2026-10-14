import test from 'node:test';
import assert from 'node:assert/strict';
import { isEchoOf } from './echo.js';

test('Jarvis\'s own words heard back are echo', () => {
  assert.equal(isEchoOf('yes sir', ['Yes, sir?']), true);
  assert.equal(isEchoOf('expect mild autumn weather', ['Tomorrow in Tallinn, expect relatively mild autumn weather.']), true);
});

test('a new request is not', () => {
  assert.equal(isEchoOf("Jarvis, what's the weather in Tallinn tomorrow", ['Yes, sir?']), false);
  assert.equal(isEchoOf('anything', []), false);
  assert.equal(isEchoOf('', ['Yes, sir?']), false);
});
