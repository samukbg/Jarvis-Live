import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCapacity, createStatusCollector, parseNvidiaSmi } from './serverStatus.js';

test('parses nvidia-smi CSV', () => {
  const [g] = parseNvidiaSmi('NVIDIA GeForce RTX 3090, 12, 5854, 24576, 56\r\n');
  assert.deepEqual(g, { name: 'NVIDIA GeForce RTX 3090', utilizationPct: 12, memoryUsedMB: 5854, memoryTotalMB: 24576, memoryFreeMB: 18722, temperatureC: 56 });
  assert.deepEqual(parseNvidiaSmi(''), []);
});

const base = (over = {}) => ({
  gpus: [{ name: 'RTX 3090', utilizationPct: 10, memoryUsedMB: 6000, memoryTotalMB: 24576, memoryFreeMB: 18576 }],
  avatar: { streamer: true, renderer: true, sessionBusy: false },
  ...over,
});

test('accepts an idle, healthy server and explains every refusal', () => {
  assert.deepEqual(assessCapacity(base()), { accepting: true, reasons: [] });
  const busy = assessCapacity(base({ avatar: { streamer: true, renderer: false, sessionBusy: true } }));
  assert.equal(busy.accepting, false);
  assert.deepEqual(busy.reasons, ['avatar renderer down', 'avatar session in use']);
  assert.match(assessCapacity(base({ gpus: [{ utilizationPct: 99, memoryFreeMB: 1000 }] })).reasons.join(), /1000 MB VRAM free.*99% busy/);
  assert.deepEqual(assessCapacity(base({ gpus: [] })).reasons, ['no NVIDIA GPU detected']);
});

test('collects GPU, streamer and renderer state, cached', async () => {
  let execCalls = 0;
  const collector = createStatusCollector({
    name: 'jarvis-test',
    version: 'abc123',
    exec: async () => { execCalls += 1; return { stdout: 'RTX 3090, 5, 4000, 24576, 40\n' }; },
    fetchStreamer: async (p) => ({ ok: true, json: async () => (p === '/session-status' ? { busy: false, since: null } : { renderer: { metrics: {} } }) }),
    cpuLoadPct: async () => 7,
  });
  const s = await collector();
  assert.equal(s.name, 'jarvis-test');
  assert.equal(s.gpus[0].memoryFreeMB, 20576);
  assert.deepEqual(s.avatar, { streamer: true, renderer: true, sessionBusy: false, sessionSince: null });
  assert.equal(s.cpu.loadPct, 7);
  assert.equal(s.capacity.accepting, true);
  await collector();
  assert.equal(execCalls, 1, 'second call within 3 s is cached');
});

test('a dead streamer means not accepting', async () => {
  const collector = createStatusCollector({ exec: async () => ({ stdout: '' }), fetchStreamer: async () => { throw new Error('down'); } });
  const s = await collector();
  assert.equal(s.avatar.streamer, false);
  assert.equal(s.capacity.accepting, false);
});

test('a missing avatar install is named in the reasons', () => {
  const status = {
    avatar: { streamer: false, renderer: false, sessionBusy: false, install: { streamerEnv: false, wslDistro: 'Ubuntu', renderer: false } },
    gpus: [{ name: 'RTX 3090', utilizationPct: 0, memoryFreeMB: 18000 }],
  };
  assert.deepEqual(assessCapacity(status).reasons, [
    'live avatar not installed: streamer_win_env missing',
    'live avatar not installed: no /root/avtr-1 in WSL Ubuntu',
  ]);
});
