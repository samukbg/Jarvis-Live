import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenText } from './spokenText.js';

test('temperatures are read as words', () => {
  assert.equal(spokenText('Sunny, high of 12°C (54°F), low 7 °C.', 'en'), 'Sunny, high of 12 degrees Celsius (54 degrees Fahrenheit), low 7 degrees Celsius.');
  assert.equal(spokenText('Il fera 1°C.', 'fr'), 'Il fera 1 degré Celsius.');
  assert.equal(spokenText('Máxima de 20,5°', 'pt'), 'Máxima de 20,5 graus');
});

test('markdown emphasis is not read out', () => {
  assert.equal(spokenText('It is **sunny** in `Paris`.', 'en'), 'It is sunny in Paris.');
});

test('plain text is unchanged', () => {
  assert.equal(spokenText('At your service, sir.', 'en'), 'At your service, sir.');
});
