import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceJoiner } from './utteranceJoiner.js';

const manualTimers = () => {
  let fn = null;
  return { setTimer: (f) => { fn = f; return 1; }, clearTimer: () => { fn = null; }, fire: () => { const f = fn; fn = null; f?.(); } };
};

test('the avatar’s transcript pieces become one line, sent once after a pause', () => {
  const t = manualTimers();
  const said = [];
  const j = new UtteranceJoiner({ onUtterance: (s) => said.push(s), setTimer: t.setTimer, clearTimer: t.clearTimer });
  for (const piece of ["C'est", 'quoi', 'la', 'température', 'pour', 'Paris', 'demain', '?']) j.add(piece);
  assert.equal(j.text, "C'est quoi la température pour Paris demain ?");
  assert.deepEqual(said, [], 'nothing logged while the user is still talking');
  t.fire();
  assert.deepEqual(said, ["C'est quoi la température pour Paris demain ?"]);
});

test('Jarvis answering (or delegating) ends the utterance at once; empty pieces are ignored', () => {
  const t = manualTimers();
  const said = [];
  const j = new UtteranceJoiner({ onUtterance: (s) => said.push(s), setTimer: t.setTimer, clearTimer: t.clearTimer });
  j.add('  ');
  j.add('Hello there.');
  j.flush();
  j.flush();
  assert.deepEqual(said, ['Hello there.']);
  t.fire();
  assert.deepEqual(said, ['Hello there.'], 'the pending timer does not log it again');
});
