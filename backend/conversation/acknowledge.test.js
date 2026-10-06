import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgement, guessLanguage } from './acknowledge.js';

test('guessLanguage: from what the user said, else the app language', () => {
  assert.equal(guessLanguage("Quelle est la température pour Paris demain ?"), 'fr');
  assert.equal(guessLanguage("C'est quoi la météo ?"), 'fr');
  assert.equal(guessLanguage('Qual é a temperatura em Lisboa amanhã?'), 'pt');
  assert.equal(guessLanguage('¿Cuál es el tiempo en Madrid mañana?'), 'es');
  assert.equal(guessLanguage('Che tempo fa a Roma domani?'), 'it');
  assert.equal(guessLanguage("What's the weather in London tomorrow?"), 'en');
  assert.equal(guessLanguage('ok', 'fr'), 'fr', 'too short to tell: the app language');
});

test('acknowledgement names the agent, in the user’s language', () => {
  assert.equal(acknowledgement('gemini', 'Quelle est la température pour Paris demain ?'), "Je m'en occupe : je demande à Antigravity.");
  assert.equal(acknowledgement('agy', "What's the weather tomorrow?"), "On it — I'm asking Antigravity.");
  assert.match(acknowledgement('claude', 'Revisa el código por favor', 'en'), /Claude/);
  assert.match(acknowledgement('hermes', '', 'pt'), /^Estou nisso/);
  assert.match(acknowledgement('somebot', 'hello there'), /On it/);
});
