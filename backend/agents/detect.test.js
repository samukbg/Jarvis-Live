import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentDetector, hermesDefaults, hermesModelsFromCache, parseAgyModels, parseOllamaList, parseVersion } from './detect.js';
import { splitHermesModel } from './hermesModel.js';

test('parses agy, ollama and version output', () => {
  assert.deepEqual(parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6\n'), ['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
  assert.deepEqual(parseOllamaList('NAME            ID   SIZE\nqwen3.8:27b     abc  17 GB\nllama3:latest   def  4 GB\n'), ['qwen3.8:27b', 'llama3:latest']);
  assert.equal(parseVersion('\n2.1.287 (Claude Code)\n'), '2.1.287 (Claude Code)');
});

test('Hermes models: configured default first, provider::model ids', () => {
  const defaults = hermesDefaults('model:\n  default: upstage/solar-pro4:free\n  provider: nous\nother:\n  model: x\n');
  assert.deepEqual(defaults, { model: 'upstage/solar-pro4:free', provider: 'nous' });
  const models = hermesModelsFromCache({ nous: { models: ['a/b', 'upstage/solar-pro4:free'] }, 'x#fp': { models: ['dup'] } }, defaults);
  assert.deepEqual(models, ['nous::upstage/solar-pro4:free', 'nous::a/b']);
  assert.deepEqual(splitHermesModel('openrouter::anthropic/claude-x'), { provider: 'openrouter', model: 'anthropic/claude-x' });
  assert.deepEqual(splitHermesModel('deepseek-v4-flash'), { provider: 'DeepSeek', model: 'deepseek-v4-flash' });
});

test('only installed agents are reported, with their models', async () => {
  const installed = { 'agy --version': '1.2.14', 'claude --version': '2.1.287 (Claude Code)', 'agy models': 'gemini-3.8-flash-high\tGemini 3.8 Flash\n' };
  const exec = async (cmd) => {
    if (cmd in installed) return { stdout: installed[cmd] };
    throw new Error(`${cmd}: not found`);
  };
  const { agents } = await createAgentDetector({ exec, env: {}, home: '/nonexistent' })();
  assert.deepEqual(agents.map((a) => a.id), ['gemini', 'claude']);
  assert.deepEqual(agents[0].models, ['gemini-3.8-flash-high']);
  assert.deepEqual(agents[1].models, ['sonnet', 'opus', 'haiku']);
});
