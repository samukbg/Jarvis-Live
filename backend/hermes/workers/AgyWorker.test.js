import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyAnswerMessage } from './AgyWorker.js';

test('a run that hit the time limit says it was stopped', () => {
  assert.match(emptyAnswerMessage(240_000, '', 240), /did not finish within 4 minutes/);
});

test('an agy that failed at once says what it reported, not "did not finish"', () => {
  const msg = emptyAnswerMessage(3_000, 'error: Individual quota reached. Resets in 67h54m0s.', 240);
  assert.equal(msg, 'Antigravity stopped without an answer: Individual quota reached. Resets in 67h54m0s.');
});

test('no stderr: a plain retry hint', () => {
  assert.match(emptyAnswerMessage(2_000, '', 240), /^Antigravity stopped without an answer\. Try again/);
});
