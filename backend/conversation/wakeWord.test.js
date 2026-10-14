import test from 'node:test';
import assert from 'node:assert/strict';
import { stripWakeWord, wakeReply } from './wakeWord.js';

test('the name alone is a call, with nothing to do', () => {
  for (const t of ['Jarvis', 'Javis', 'jarvis.', 'Hey Jarvis!', 'Jarvis Live', 'ok, Jervis?']) {
    assert.deepEqual(stripWakeWord(t), { called: true, rest: '' }, t);
  }
});

test('the name in front of a request is dropped from it', () => {
  assert.deepEqual(stripWakeWord("Jarvis, what's the weather tomorrow?"), { called: true, rest: "what's the weather tomorrow?" });
  assert.deepEqual(stripWakeWord('Hey Javis open Spotify'), { called: true, rest: 'open Spotify' });
});

test('other text is left alone', () => {
  assert.deepEqual(stripWakeWord('What is Jarvis Live?'), { called: false, rest: 'What is Jarvis Live?' });
  assert.deepEqual(stripWakeWord('Jarvisation of the pipeline'), { called: false, rest: 'Jarvisation of the pipeline' });
  assert.deepEqual(stripWakeWord(''), { called: false, rest: '' });
});

test('the reply follows the language', () => {
  assert.equal(wakeReply('en'), 'Yes, sir?');
  assert.equal(wakeReply('fra'), 'Oui, monsieur ?');
  assert.equal(wakeReply('pt-BR'), 'Sim, senhor?');
  assert.equal(wakeReply('xx'), 'Yes, sir?');
});
