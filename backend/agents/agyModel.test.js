import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyModelArgs } from './agyModel.js';

const models = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low'];

test('a full model id (effort included) goes as is: no --effort to conflict with', () => {
  assert.deepEqual(agyModelArgs('gemini-3.8-flash-high', models), ['--model', 'gemini-3.8-flash-high']);
  assert.deepEqual(agyModelArgs(' Gemini-3.1-Pro-Low ', models), ['--model', 'gemini-3.1-pro-low']);
});

test('a bare model name gets an effort agy offers for it (pro has no "medium")', () => {
  assert.deepEqual(agyModelArgs('gemini-3.8-flash', models), ['--model', 'gemini-3.8-flash-medium']);
  assert.deepEqual(agyModelArgs('gemini-3.1-pro', models), ['--model', 'gemini-3.1-pro-high']);
  assert.deepEqual(agyModelArgs('gemini-3.8-flash', []), ['--model', 'gemini-3.8-flash', '--effort', 'medium'], 'model list unknown');
});

test('nothing usable selected: the first model agy lists, else agy’s own default', () => {
  assert.deepEqual(agyModelArgs('', models), ['--model', 'gemini-3.8-flash-high']);
  assert.deepEqual(agyModelArgs('claude-3-haiku', models), ['--model', 'gemini-3.8-flash-high']);
  assert.deepEqual(agyModelArgs(undefined, []), []);
});

test('voice delegations: the same model at the effort asked for, when agy offers it', () => {
  assert.deepEqual(agyModelArgs('gemini-3.8-flash-high', models, { effort: 'low' }), ['--model', 'gemini-3.8-flash-low']);
  assert.deepEqual(agyModelArgs('gemini-3.1-pro-high', models, { effort: 'low' }), ['--model', 'gemini-3.1-pro-low']);
  assert.deepEqual(agyModelArgs('gemini-3.1-pro-high', models, { effort: 'medium' }), ['--model', 'gemini-3.1-pro-high'], 'pro has no medium');
  assert.deepEqual(agyModelArgs('gemini-3.8-flash', [], { effort: 'low' }), ['--model', 'gemini-3.8-flash', '--effort', 'low']);
  assert.deepEqual(agyModelArgs('', models, { effort: 'low' }), ['--model', 'gemini-3.8-flash-low']);
});
