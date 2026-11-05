import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createLfmRuntime, pickLlamaAssets, LFM_MODEL_FILE, LFM_MMPROJ_FILE } from './lfmRuntime.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lfm-'));
const quiet = () => {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake llama-server children + a /health that answers ok while one of them runs. */
function fakeServer({ exitRightAway = false } = {}) {
  const children = [];
  let alive = 0;
  const spawnImpl = (bin, args, opts) => {
    const c = new EventEmitter();
    Object.assign(c, { bin, args, opts, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, killed: 0 });
    c.kill = (sig = 'SIGTERM') => {
      c.killed++;
      if (c.exitCode == null && c.signalCode == null) setImmediate(() => c.exit(null, sig));
      return true;
    };
    c.exit = (code, sig = null) => {
      if (c.exitCode != null || c.signalCode != null) return;
      c.exitCode = code;
      c.signalCode = sig;
      alive--;
      c.emit('exit', code, sig);
    };
    alive++;
    children.push(c);
    if (exitRightAway) setImmediate(() => { c.stderr.write('error: boom\n'); c.exit(1); });
    return c;
  };
  return { children, spawnImpl, alive: () => alive };
}

function healthResponse(state) {
  if (state === 'ok') return Response.json({ status: 'ok' });
  if (state === 'loading') return Response.json({ error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }, { status: 503 });
  return new Response('<html>not llama</html>', { status: 404 });
}

function writeModels(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LFM_MODEL_FILE), 'model');
  fs.writeFileSync(path.join(dir, LFM_MMPROJ_FILE), 'mmproj');
}

function fakeBin(dir, name = 'llama-server') {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  return bin;
}

test('picks the llama.cpp build per platform, arch and GPU', () => {
  const p = (platform, arch, nvidia, override) => pickLlamaAssets({ platform, arch, nvidia, override });
  assert.deepEqual(p('darwin', 'arm64'), { asset: 'llama-b11960-bin-macos-arm64.tar.gz', cudart: null, ngl: false });
  assert.equal(p('darwin', 'x64').asset, 'llama-b11960-bin-macos-x64.tar.gz');
  assert.deepEqual(p('win32', 'x64', true), { asset: 'llama-b11960-bin-win-cuda-12.4-x64.zip', cudart: 'cudart-llama-bin-win-cuda-12.4-x64.zip', ngl: true });
  assert.deepEqual(p('win32', 'x64', false), { asset: 'llama-b11960-bin-win-vulkan-x64.zip', cudart: null, ngl: true });
  assert.equal(p('win32', 'arm64', false).asset, 'llama-b11960-bin-win-cpu-arm64.zip');
  assert.deepEqual(p('linux', 'x64', true), { asset: 'llama-b11960-bin-ubuntu-cuda-12.8-x64.tar.gz', cudart: 'cudart-llama-b11960-bin-ubuntu-cuda-12.8-x64.tar.gz', ngl: true });
  assert.deepEqual(p('linux', 'x64', false), { asset: 'llama-b11960-bin-ubuntu-x64.tar.gz', cudart: null, ngl: false });
  assert.equal(p('linux', 'arm64', true).asset, 'llama-b11960-bin-ubuntu-arm64.tar.gz');
  assert.deepEqual(p('linux', 'x64', true, 'llama-b11960-bin-ubuntu-vulkan-x64.tar.gz'), { asset: 'llama-b11960-bin-ubuntu-vulkan-x64.tar.gz', cudart: null, ngl: true });
  assert.equal(p('freebsd', 'x64'), null);
});

test('reuses the binary and the model already on disk: no download, spawns and waits for /health', async () => {
  const home = tmp();
  const repo = tmp();
  writeModels(path.join(repo, 'scratch', 'lfm'));
  const bin = fakeBin(path.join(tmp(), 'bin'));
  const srv = fakeServer();
  const urls = [];
  let healthCalls = 0;
  const fetchImpl = async (u) => {
    urls.push(String(u));
    healthCalls++;
    if (!srv.alive()) throw new TypeError('fetch failed');
    return healthResponse(healthCalls < 4 ? 'loading' : 'ok');
  };
  const lfm = createLfmRuntime({ home, repoRoot: repo, port: 9951, log: quiet, fetchImpl, spawnImpl: srv.spawnImpl, platform: 'darwin', arch: 'arm64', env: { LFM_SERVER_BIN: bin, PATH: '' }, healthIntervalMs: 5 });
  assert.equal(lfm.installed(), true);
  assert.equal(lfm.status().state, 'idle');
  assert.equal(await lfm.ensure(), true);
  assert.equal(lfm.status().state, 'ready');
  assert.equal(lfm.status().url, 'ws://127.0.0.1:9951/v1/realtime');
  assert.equal(srv.children.length, 1);
  const { args } = srv.children[0];
  assert.equal(srv.children[0].bin, bin);
  assert.deepEqual(args, ['-m', path.join(repo, 'scratch', 'lfm', LFM_MODEL_FILE), '-mm', path.join(repo, 'scratch', 'lfm', LFM_MMPROJ_FILE), '--host', '127.0.0.1', '--port', '9951', '--jinja']);
  assert.ok(urls.every((u) => u === 'http://127.0.0.1:9951/health'), 'only health checks, no downloads');
  assert.equal(await lfm.ensure(), true, 'idempotent');
  assert.equal(srv.children.length, 1);
  lfm.stop();
});

test('model lookup order: env path, <home>/models/lfm, repo models/lfm, repo scratch/lfm; binary from PATH', async () => {
  const home = tmp();
  const repo = tmp();
  writeModels(path.join(repo, 'scratch', 'lfm'));
  writeModels(path.join(repo, 'models', 'lfm'));
  writeModels(path.join(home, 'models', 'lfm'));
  const envModel = path.join(tmp(), 'm.gguf');
  fs.writeFileSync(envModel, 'x');
  const binDir = path.join(tmp(), 'path-bin');
  const bin = fakeBin(binDir);
  const srv = fakeServer();
  const fetchImpl = async () => { if (!srv.alive()) throw new TypeError('fetch failed'); return healthResponse('ok'); };
  const lfm = createLfmRuntime({ home, repoRoot: repo, log: quiet, fetchImpl, spawnImpl: srv.spawnImpl, platform: 'linux', arch: 'x64', env: { PATH: `/nope:${binDir}`, LFM_MODEL_PATH: envModel }, hasNvidia: async () => true, healthIntervalMs: 5 });
  assert.equal(await lfm.ensure(), true);
  const c = srv.children[0];
  assert.equal(c.bin, bin);
  assert.equal(c.args[1], envModel);
  assert.equal(c.args[3], path.join(home, 'models', 'lfm', LFM_MMPROJ_FILE));
  assert.deepEqual(c.args.slice(-2), ['-ngl', '99'], 'an NVIDIA GPU with a PATH binary: offload');
  assert.equal(c.opts.env.LD_LIBRARY_PATH, binDir);
  lfm.stop();
});

test('a llama.cpp server already on the port is used as it is (external), never killed', async () => {
  const srv = fakeServer();
  const lfm = createLfmRuntime({ home: tmp(), log: quiet, fetchImpl: async () => healthResponse('ok'), spawnImpl: srv.spawnImpl, platform: 'darwin', arch: 'arm64', env: { PATH: '' } });
  assert.equal(lfm.installed(), false);
  assert.equal(lfm.status().state, 'missing');
  assert.equal(await lfm.ensure(), true);
  assert.equal(lfm.status().external, true);
  assert.equal(lfm.installed(), true);
  assert.equal(srv.children.length, 0);
  lfm.stop();
  assert.equal(srv.children.length, 0);
});

test('another program on the port: error state, nothing spawned or killed', async () => {
  const srv = fakeServer();
  const lfm = createLfmRuntime({ home: tmp(), log: quiet, fetchImpl: async () => healthResponse('foreign'), spawnImpl: srv.spawnImpl, platform: 'darwin', arch: 'arm64', env: { PATH: '' } });
  assert.equal(await lfm.ensure(), false);
  assert.equal(lfm.status().state, 'error');
  assert.match(lfm.status().error, /port 9931 is used by another program/);
  assert.equal(srv.children.length, 0);
});

test('without download: missing state, nothing fetched but /health', async () => {
  const urls = [];
  const lfm = createLfmRuntime({ home: tmp(), log: quiet, fetchImpl: async (u) => { urls.push(String(u)); throw new TypeError('fetch failed'); }, spawnImpl: fakeServer().spawnImpl, platform: 'darwin', arch: 'arm64', env: { PATH: '' } });
  assert.equal(await lfm.ensure({ download: false }), false);
  assert.equal(lfm.status().state, 'missing');
  assert.deepEqual(urls, ['http://127.0.0.1:9931/health']);
});

/** A real .tar.gz shaped like the macOS release: llama-b11960/llama-server + a dylib. */
function makeReleaseTarball() {
  const src = tmp();
  fs.mkdirSync(path.join(src, 'llama-b11960'));
  fs.writeFileSync(path.join(src, 'llama-b11960', 'llama-server'), '#!/bin/sh\necho fake\n', { mode: 0o644 });
  fs.writeFileSync(path.join(src, 'llama-b11960', 'libllama.dylib'), 'lib');
  const out = path.join(tmp(), 'rel.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', src, 'llama-b11960']);
  return fs.readFileSync(out);
}

/** Serves `files` (url suffix → Buffer) with HEAD, Range (206) and small chunks. */
function fileServer(files, srv, { shortBody = null } = {}) {
  const calls = [];
  const fetchImpl = async (u, opts = {}) => {
    u = String(u);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, range: opts.headers?.Range || null });
    if (u.endsWith('/health')) {
      if (!srv.alive()) throw new TypeError('fetch failed');
      return healthResponse('ok');
    }
    const key = Object.keys(files).find((k) => u.endsWith(`/${k}`));
    if (!key) return new Response('nope', { status: 404 });
    const full = files[key];
    if (method === 'HEAD') return new Response(null, { headers: { 'content-length': String(full.length) } });
    let start = 0;
    const m = /bytes=(\d+)-/.exec(opts.headers?.Range || '');
    if (m) start = Number(m[1]);
    let body = full.subarray(start);
    const headers = { 'content-length': String(body.length) };
    if (key === shortBody) body = body.subarray(0, body.length - 3);
    if (m) headers['content-range'] = `bytes ${start}-${full.length - 1}/${full.length}`;
    let i = 0;
    const stream = new ReadableStream({
      pull(ctl) {
        if (i >= body.length) return ctl.close();
        ctl.enqueue(new Uint8Array(body.subarray(i, i + 1000)));
        i += 1000;
      },
    });
    return new Response(stream, { status: m ? 206 : 200, headers });
  };
  return { fetchImpl, calls };
}

test('downloads what is missing: resumes the .part with Range, renames at the end, installs llama-server, reports progress', { skip: process.platform === 'win32' }, async () => {
  const home = tmp();
  const model = Buffer.alloc(50_000, 7);
  const mmproj = Buffer.alloc(20_000, 9);
  const tarball = makeReleaseTarball();
  fs.mkdirSync(path.join(home, 'models', 'lfm'), { recursive: true });
  fs.writeFileSync(path.join(home, 'models', 'lfm', `${LFM_MODEL_FILE}.part`), model.subarray(0, 30_000));
  const srv = fakeServer();
  const files = { 'llama-b11960-bin-macos-arm64.tar.gz': tarball, [LFM_MODEL_FILE]: model, [LFM_MMPROJ_FILE]: mmproj };
  const { fetchImpl, calls } = fileServer(files, srv);
  const lfm = createLfmRuntime({ home, log: quiet, fetchImpl, spawnImpl: srv.spawnImpl, platform: 'darwin', arch: 'arm64', env: { PATH: '' }, healthIntervalMs: 5 });
  const events = [];
  lfm.onChange((s) => events.push(s));
  const [a, b] = await Promise.all([lfm.ensure(), lfm.ensure()]);
  assert.equal(a, true);
  assert.equal(b, true);

  const gets = calls.filter((c) => c.method === 'GET' && !c.url.endsWith('/health'));
  assert.equal(gets.length, 3, 'each file fetched once even with two ensure() calls');
  assert.ok(gets[0].url.startsWith('https://github.com/ggml-org/llama.cpp/releases/download/b11960/'));
  assert.equal(gets.find((c) => c.url.endsWith(LFM_MODEL_FILE)).range, 'bytes=30000-');
  assert.equal(gets.find((c) => c.url.endsWith(`/${LFM_MMPROJ_FILE}`)).url, `https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/main/${LFM_MMPROJ_FILE}`);

  assert.deepEqual(fs.readFileSync(path.join(home, 'models', 'lfm', LFM_MODEL_FILE)), model);
  assert.deepEqual(fs.readFileSync(path.join(home, 'models', 'lfm', LFM_MMPROJ_FILE)), mmproj);
  assert.ok(!fs.existsSync(path.join(home, 'models', 'lfm', `${LFM_MODEL_FILE}.part`)));
  const bin = path.join(home, 'lfm', 'llama-b11960', 'llama-b11960', 'llama-server');
  assert.ok(fs.statSync(bin).mode & 0o100, 'llama-server is executable');
  assert.ok(fs.existsSync(path.join(path.dirname(bin), 'libllama.dylib')), 'libraries stay next to the binary');
  assert.deepEqual(fs.readdirSync(path.join(home, 'lfm')).sort(), ['downloads', 'llama-b11960'], 'no temp extraction folder left');
  assert.deepEqual(fs.readdirSync(path.join(home, 'lfm', 'downloads')), [], 'archive removed after install');
  assert.equal(srv.children[0].bin, bin);
  assert.equal(srv.children[0].opts.cwd, path.dirname(bin));

  assert.equal(events[0].state, 'downloading', 'shown right away, before the sizes are known');
  const dl = events.filter((e) => e.state === 'downloading' && e.totalBytes != null);
  assert.ok(dl.length >= 2, 'progress events while downloading');
  const total = tarball.length + model.length + mmproj.length;
  assert.ok(dl.every((e) => e.totalBytes === total));
  assert.equal(dl[0].bytes, 30_000, 'the resumed .part counts from the start');
  for (let i = 1; i < dl.length; i++) assert.ok(dl[i].bytes >= dl[i - 1].bytes, 'bytes only grow');
  assert.equal(dl.at(-1).bytes, total);
  assert.equal(dl.at(-1).progress, 1);
  assert.deepEqual([...new Set(events.map((e) => e.state))], ['downloading', 'starting', 'ready']);
  lfm.stop();
});

test('a download shorter than its content-length fails and keeps the .part for the next try', async () => {
  const home = tmp();
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'models', 'lfm'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'models', 'lfm', LFM_MODEL_FILE), 'model');
  const srv = fakeServer();
  const bin = fakeBin(path.join(tmp(), 'b'));
  const { fetchImpl } = fileServer({ [LFM_MMPROJ_FILE]: Buffer.alloc(5000, 1) }, srv, { shortBody: LFM_MMPROJ_FILE });
  const lfm = createLfmRuntime({ home, repoRoot: repo, log: quiet, fetchImpl, spawnImpl: srv.spawnImpl, platform: 'darwin', arch: 'arm64', env: { LFM_SERVER_BIN: bin } });
  assert.equal(await lfm.ensure(), false);
  assert.equal(lfm.status().state, 'error');
  assert.match(lfm.status().error, /got 4997 of 5000 bytes/);
  assert.equal(fs.statSync(path.join(home, 'models', 'lfm', `${LFM_MMPROJ_FILE}.part`)).size, 4997);
  assert.ok(!fs.existsSync(path.join(home, 'models', 'lfm', LFM_MMPROJ_FILE)));
  assert.equal(srv.children.length, 0);
});

function readyRuntime(srv, extra = {}) {
  const repo = tmp();
  writeModels(path.join(repo, 'models', 'lfm'));
  const bin = fakeBin(path.join(tmp(), 'b'));
  const logs = [];
  const fetchImpl = async () => { if (!srv.alive()) throw new TypeError('fetch failed'); return healthResponse('ok'); };
  const lfm = createLfmRuntime({ home: tmp(), repoRoot: repo, log: (l) => logs.push(l), fetchImpl, spawnImpl: srv.spawnImpl, platform: 'darwin', arch: 'arm64', env: { LFM_SERVER_BIN: bin }, healthIntervalMs: 5, ...extra });
  return { lfm, logs };
}

test('restarts a crashed llama-server after the first backoff delay', async () => {
  const srv = fakeServer();
  const { lfm, logs } = readyRuntime(srv, { restartDelaysMs: [20, 40, 60] });
  assert.equal(await lfm.ensure(), true);
  srv.children[0].exit(1);
  assert.equal(lfm.status().state, 'starting');
  await wait(120);
  assert.equal(srv.children.length, 2, 'restarted once');
  assert.equal(lfm.status().state, 'ready');

  assert.ok(logs.some((l) => l.startsWith('[LFM] starting')));
  lfm.stop();
});

test('a llama-server that keeps crashing: 3 restarts with growing delays, then an error', async () => {
  const srv2 = fakeServer();
  const starts = [];
  const spawn2 = (...a) => { starts.push(Date.now()); const c = srv2.spawnImpl(...a); setImmediate(() => { c.stderr.write('error: out of memory\n'); setImmediate(() => c.exit(1)); }); return c; };
  const neverUp = async () => { throw new TypeError('fetch failed'); };
  const r2 = readyRuntime(srv2, { restartDelaysMs: [20, 40, 60], spawnImpl: spawn2, fetchImpl: neverUp });
  assert.equal(await r2.lfm.ensure(), false);
  assert.equal(starts.length, 4, 'first start + 3 restarts');
  assert.ok(starts[1] - starts[0] >= 18 && starts[2] - starts[1] >= 38 && starts[3] - starts[2] >= 58, 'delays grow');
  assert.equal(r2.lfm.status().state, 'error');
  assert.match(r2.lfm.status().error, /code 1.*out of memory/);
  assert.ok(r2.logs.some((l) => /restarting in 0\.02 s/.test(l)));
  assert.ok(r2.logs.some((l) => l === '[LFM] error: out of memory'), 'child output logged with the [LFM] prefix');
});

test('stop() kills only its own child and does not restart it', async () => {
  const srv = fakeServer();
  const { lfm } = readyRuntime(srv, { restartDelaysMs: [10, 10, 10] });
  assert.equal(await lfm.ensure(), true);
  const c = srv.children[0];
  lfm.stop();
  assert.equal(c.killed, 1);
  await wait(60);
  assert.equal(srv.children.length, 1, 'no restart after stop');
  assert.equal(lfm.status().state, 'idle');
  lfm.stop();
  assert.equal(c.killed, 1, 'a second stop has nothing to kill');
});

test('child output is throttled', async () => {
  const srv = fakeServer();
  const { lfm, logs } = readyRuntime(srv);
  assert.equal(await lfm.ensure(), true);
  for (let i = 0; i < 200; i++) srv.children[0].stderr.write(`slot ${i}\n`);
  await wait(10);
  const shown = logs.filter((l) => /^\[LFM\] slot /.test(l));
  assert.ok(shown.length > 0 && shown.length <= 15, `logged ${shown.length} lines`);
  lfm.stop();
});
