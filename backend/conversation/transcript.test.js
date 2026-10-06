import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptBuffer } from './transcript.js';

test('Gemini Live fragments make one sentence, spaces kept', () => {
  const b = new TranscriptBuffer();
  for (const f of ["C'est", ' quo', 'i la', ' tem', "pérature à Paris aujourd'hui."]) b.add(f);
  assert.equal(b.text, "C'est quoi la température à Paris aujourd'hui.");
  assert.equal(b.flush(), "C'est quoi la température à Paris aujourd'hui.");
  assert.equal(b.flush(), null, 'flushed once');
  assert.equal(b.text, '');
});

test('blank fragments and extra whitespace are ignored', () => {
  const b = new TranscriptBuffer();
  assert.equal(b.add('   '), '');
  b.add('Salut,');
  b.add('  tu   m’entends ?  ');
  assert.equal(b.flush(), 'Salut, tu m’entends ?');
});
