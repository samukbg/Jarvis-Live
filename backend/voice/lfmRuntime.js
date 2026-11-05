// Runs the default live voice on this computer: Liquid AI's LFM3-Audio model in llama.cpp's
// llama-server, which answers OpenAI Realtime WebSocket events at ws://127.0.0.1:<port>/v1/realtime.
// The backend finds or downloads llama-server and the model, starts the server, restarts it when
// it crashes (2 s, 5 s, 15 s, then gives up) and stops it when the backend exits.
//
// Where files are looked for, first match wins:
//   llama-server: LFM_SERVER_BIN, <home>/lfm/llama-b11960/ (downloaded), llama-server on PATH.
//   model files:  LFM_MODEL_PATH / LFM_MMPROJ_PATH, <home>/models/lfm, <repo>/models/lfm, <repo>/scratch/lfm.
// Missing parts are downloaded into <home> (llama.cpp from GitHub, the model from Hugging Face).
// Downloads go to a .part file first, so they resume after a restart. The llama.cpp build is
// macOS → Metal, Windows/Linux x64 with an NVIDIA GPU → CUDA, else Vulkan (Windows) or CPU (Linux).
// LFM_LLAMA_ASSET picks another release file.
//
// A server already answering /health on the port (boot.sh, a dev run) is used as it is. Another
// program on the port is an error: nothing is ever killed except the child this module started.
//
//   const lfm = createLfmRuntime({ home, repoRoot });
//   lfm.onChange((s) => broadcast(s));   // { state, progress, bytes, totalBytes, file, error, url, external }
//   await lfm.ensure();                  // true when the server is ready; lfm.stop() to stop it
//
// state: idle (installed, not running), missing (files not on disk), downloading, starting, ready, error.
// Only node built-ins: this runs in the desktop app, whose node_modules is trimmed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const LLAMA_BUILD = 'b11960';
export const LFM_MODEL_FILE = 'LFM3-Audio-2B-Q4_K_M.gguf';
export const LFM_MMPROJ_FILE = 'mmproj-LFM3-Audio-2B-Q8_0.gguf';
const RELEASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}`;
const MODEL_URL = 'https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/main';
const STABLE_MS = 60_000; // a child that ran this long resets the quick-restart count
const LOG_LINES_PER_WINDOW = 15; // llama-server prints a lot; log at most this many lines per 10 s
const LOG_WINDOW_MS = 10_000;
const PROGRESS_EVERY_MS = 250;

/** The llama.cpp release files for this machine: { asset, cudart (or null), ngl (offload flag needed) }. */
export function pickLlamaAssets({ platform, arch, nvidia = false, override } = {}) {
  const tag = `llama-${LLAMA_BUILD}-bin`;
  let asset = override || null;
  if (!asset) {
    if (platform === 'darwin') asset = `${tag}-macos-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
    else if (platform === 'win32') asset = arch === 'arm64' ? `${tag}-win-cpu-arm64.zip` : nvidia ? `${tag}-win-cuda-12.4-x64.zip` : `${tag}-win-vulkan-x64.zip`;
    else if (platform === 'linux') asset = arch === 'arm64' ? `${tag}-ubuntu-arm64.tar.gz` : nvidia ? `${tag}-ubuntu-cuda-12.8-x64.tar.gz` : `${tag}-ubuntu-x64.tar.gz`;
    else return null;
  }
  const cuda = /-cuda-([\d.]+-(?:x64|arm64))\./.exec(asset);
  const cudart = !cuda ? null : asset.endsWith('.zip') ? `cudart-llama-bin-win-cuda-${cuda[1]}.zip` : `cudart-${asset}`;
  return { asset, cudart, ngl: /-(cuda|vulkan|rocm|sycl|opencl)-/.test(asset) };
}

/** True when nvidia-smi runs and lists a GPU. */
export function detectNvidia() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['-L'], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(!err && /GPU/.test(String(stdout))));
  });
}

/** True when the CUDA 12 runtime libraries llama.cpp needs are already installed (no cudart download). */
function detectCudaRuntime(platform, env) {
  if (platform === 'win32') {
    return Promise.resolve(['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'].every((f) => findOnPath(f, env, platform)));
  }
  return new Promise((resolve) => {
    const ldconfig = fs.existsSync('/sbin/ldconfig') ? '/sbin/ldconfig' : 'ldconfig';
    execFile(ldconfig, ['-p'], { timeout: 5000 }, (err, out) => resolve(!err && /libcudart\.so\.12/.test(out) && /libcublas\.so\.12/.test(out)));
  });
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function findOnPath(name, env, platform) {
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || env.Path || '').split(sep)) {
    if (dir && isFile(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** The first file called `name` in `dir`, at most `depth` folders down. */
function findFile(dir, name, depth = 3) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const hit = entries.find((e) => e.isFile() && e.name === name);
  if (hit) return path.join(dir, name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findFile(path.join(dir, e.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve();
    });
  });
}

export function createLfmRuntime({
  home, repoRoot, port = 9931, log = console.log, fetchImpl = fetch, spawnImpl = spawn,
  platform = process.platform, arch = process.arch, env = process.env, hasNvidia, hasCudaRuntime,
  restartDelaysMs = [2000, 5000, 15000], readyTimeoutMs = 120_000, healthIntervalMs = 500,
} = {}) {
  const exe = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const lfmDir = path.join(home, 'lfm');
  const installDir = path.join(lfmDir, `llama-${LLAMA_BUILD}`);
  const modelsDir = path.join(home, 'models', 'lfm');
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const url = `ws://127.0.0.1:${port}/v1/realtime`;
  const listeners = new Set();
  const st = { state: 'idle', progress: null, bytes: 0, totalBytes: null, file: null, error: null, url, external: false };
  let child = null;
  let childStartedAt = 0;
  let restarts = 0;
  let restartTimer = null;
  let stopping = false;
  let inflight = null;
  let abort = null;
  let lastEmit = 0;
  let nvidia = null;
  const tail = [];

  const gpu = () => {
    if (nvidia == null) nvidia = (hasNvidia || detectNvidia)().catch(() => false);
    return nvidia;
  };

  function emit(force = true) {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_EVERY_MS) return;
    lastEmit = now;
    const s = status();
    for (const fn of listeners) { try { fn(s); } catch { /* a listener's bug isn't ours */ } }
  }

  function set(patch) {
    Object.assign(st, patch);
    if (patch.state && patch.state !== 'downloading') Object.assign(st, { progress: null, file: null });
    if (patch.state && patch.state !== 'error') st.error = null;
    emit();
  }

  function findBinary() {
    if (env.LFM_SERVER_BIN && isFile(env.LFM_SERVER_BIN)) return { bin: env.LFM_SERVER_BIN, source: 'env' };
    const downloaded = findFile(installDir, exe);
    if (downloaded) return { bin: downloaded, source: 'downloaded' };
    const onPath = findOnPath(exe, env, platform);
    return onPath ? { bin: onPath, source: 'path' } : null;
  }

  function findModel(file, envKey) {
    const candidates = [env[envKey], path.join(modelsDir, file)];
    if (repoRoot) candidates.push(path.join(repoRoot, 'models', 'lfm', file), path.join(repoRoot, 'scratch', 'lfm', file));
    return candidates.find((p) => p && isFile(p)) || null;
  }

  const findAll = () => ({ found: findBinary(), model: findModel(LFM_MODEL_FILE, 'LFM_MODEL_PATH'), mmproj: findModel(LFM_MMPROJ_FILE, 'LFM_MMPROJ_PATH') });

  function installed() {
    if (st.external) return true;
    const { found, model, mmproj } = findAll();
    return Boolean(found && model && mmproj);
  }

  function status() {
    return { ...st };
  }

  /** ok | loading (llama.cpp, model loading) | down (nothing answers) | foreign (another program). */
  async function probe() {
    let res;
    try { res = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(3000) }); } catch { return 'down'; }
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 200 && body?.status === 'ok') return 'ok';
    if (res.status === 503 && /loading model/i.test(body?.error?.message || '')) return 'loading';
    return 'foreign';
  }

  // ---- downloads ----

  async function headSize(fileUrl, signal) {
    try {
      const r = await fetchImpl(fileUrl, { method: 'HEAD', redirect: 'follow', signal });
      const n = Number(r.headers.get('content-length'));
      return r.ok && n > 0 ? n : null;
    } catch { return null; }
  }

  function updateProgress(items) {
    const bytes = items.reduce((n, it) => n + it.done, 0);
    const totalBytes = items.every((it) => it.size) ? items.reduce((n, it) => n + it.size, 0) : null;
    Object.assign(st, { bytes, totalBytes, progress: totalBytes ? Math.min(1, bytes / totalBytes) : null });
  }

  async function downloadOne(item, items, signal, retried = false) {
    const part = `${item.dest}.part`;
    let have = 0;
    try { have = fs.statSync(part).size; } catch { /* fresh */ }
    const res = await fetchImpl(item.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow', signal });
    if (res.status === 416 && have && !retried) { // the .part can't be resumed: start over
      fs.rmSync(part, { force: true });
      return downloadOne(item, items, signal, true);
    }
    if (!res.ok || !res.body) throw new Error(`download ${item.name}: HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length')) || null;
    const append = res.status === 206 && have > 0;
    let total;
    if (append) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      total = m ? Number(m[1]) : length ? have + length : null;
    } else {
      have = 0;
      total = length;
    }
    if (total) item.size = total;
    item.done = have;
    set({ state: 'downloading', file: item.name });
    updateProgress(items);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        item.done += chunk.length;
        updateProgress(items);
        emit(false);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }), { signal });
    const size = fs.statSync(part).size;
    if (total && size !== total) {
      if (size > total) fs.rmSync(part, { force: true });
      throw new Error(`download ${item.name}: got ${size} of ${total} bytes`);
    }
    fs.renameSync(part, item.dest);
    item.done = size;
    updateProgress(items);
    emit();
  }

  async function downloadAll(items) {
    abort = new AbortController();
    const { signal } = abort;
    try {
      set({ state: 'downloading', file: items[0].name, bytes: 0, totalBytes: null });
      await Promise.all(items.map(async (it) => {
        it.size = await headSize(it.url, signal);
        try { it.done = fs.statSync(`${it.dest}.part`).size; } catch { it.done = 0; }
      }));
      updateProgress(items);
      emit();
      for (const it of items) await downloadOne(it, items, signal); // one file at a time
    } finally {
      abort = null;
    }
  }

  // ---- llama.cpp install ----

  function tarCommand() {
    if (platform !== 'win32') return 'tar';
    const sys = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');
    return isFile(sys) ? sys : 'tar'; // System32 bsdtar reads .zip; Git's GNU tar doesn't
  }

  async function extract(archive, into) {
    fs.mkdirSync(into, { recursive: true });
    await run(tarCommand(), [archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', into]);
  }

  async function installLlama(archive, cudartArchive, asset) {
    const tmp = path.join(lfmDir, `.extract-${process.pid}-${Date.now()}`);
    try {
      await extract(archive, tmp);
      const bin = findFile(tmp, exe);
      if (!bin) throw new Error(`${path.basename(archive)} has no ${exe}`);
      const binDir = path.dirname(bin);
      if (cudartArchive) { // the CUDA runtime DLLs/.so files go next to llama-server
        const ctmp = `${tmp}-cudart`;
        try {
          await extract(cudartArchive, ctmp);
          let src = ctmp;
          for (;;) {
            const entries = fs.readdirSync(src, { withFileTypes: true });
            if (entries.length === 1 && entries[0].isDirectory()) src = path.join(src, entries[0].name);
            else break;
          }
          fs.cpSync(src, binDir, { recursive: true, verbatimSymlinks: true });
        } finally {
          fs.rmSync(ctmp, { recursive: true, force: true });
        }
      }
      if (platform !== 'win32') fs.chmodSync(bin, 0o755);
      fs.writeFileSync(path.join(tmp, '.asset'), `${asset}\n`);
      fs.rmSync(installDir, { recursive: true, force: true }); // only reached when it had no usable binary
      fs.renameSync(tmp, installDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    for (const a of [archive, cudartArchive]) if (a) fs.rmSync(a, { force: true });
  }

  async function chooseAssets() {
    const x64 = arch === 'x64' && platform !== 'darwin';
    const picked = pickLlamaAssets({ platform, arch, nvidia: x64 && !env.LFM_LLAMA_ASSET ? await gpu() : false, override: env.LFM_LLAMA_ASSET });
    if (!picked) throw new Error(`no llama.cpp build for ${platform}-${arch}; set LFM_SERVER_BIN`);
    if (picked.cudart && await (hasCudaRuntime || (() => detectCudaRuntime(platform, env)))().catch(() => false)) picked.cudart = null;
    return picked;
  }

  // ---- the child ----

  async function offloadFlag(found) {
    if (platform === 'darwin') return false; // Metal offloads by default
    if (found.source === 'downloaded') {
      try { return pickLlamaAssets({ override: fs.readFileSync(path.join(installDir, '.asset'), 'utf8').trim() }).ngl; } catch { return false; }
    }
    return gpu();
  }

  const logBudget = { windowStart: 0, used: 0, skipped: 0 };
  function logLine(line) {
    tail.push(line);
    if (tail.length > 20) tail.shift();
    const now = Date.now();
    if (now - logBudget.windowStart > LOG_WINDOW_MS) {
      if (logBudget.skipped) log(`[LFM] (${logBudget.skipped} lines not shown)`);
      Object.assign(logBudget, { windowStart: now, used: 0, skipped: 0 });
    }
    if (logBudget.used++ < LOG_LINES_PER_WINDOW) log(`[LFM] ${line}`);
    else logBudget.skipped++;
  }

  function readLines(stream) {
    if (!stream) return;
    let buf = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) logLine(l.trimEnd());
    });
  }

  function startChild({ bin, args, ngl }) {
    const fullArgs = [...args];
    if (ngl) fullArgs.push('-ngl', '99');
    const childEnv = { ...env };
    if (platform === 'linux') childEnv.LD_LIBRARY_PATH = [path.dirname(bin), env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    log(`[LFM] starting ${bin} on port ${port}`);
    const c = spawnImpl(bin, fullArgs, { cwd: path.dirname(bin), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child = c;
    childStartedAt = Date.now();
    trackChild(c);
    readLines(c.stdout);
    readLines(c.stderr);
    let done = false;
    const onGone = (code, signal, err) => {
      if (done) return;
      done = true;
      untrackChild(c);
      if (child !== c) return;
      child = null;
      if (stopping) return;
      if (Date.now() - childStartedAt > STABLE_MS) restarts = 0;
      const why = err ? err.message : `exited (${signal || `code ${code}`})`;
      if (restarts >= restartDelaysMs.length) {
        const last = tail.slice(-5).join(' | ');
        set({ state: 'error', error: `llama-server ${why}${last ? `: ${last}` : ''}`.slice(0, 600) });
        return;
      }
      const delay = restartDelaysMs[restarts++];
      log(`[LFM] llama-server ${why}, restarting in ${delay / 1000} s`);
      set({ state: 'starting' });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (stopping) return;
        try {
          startChild({ bin, args, ngl });
          waitReady();
        } catch (e) {
          set({ state: 'error', error: e.message });
        }
      }, delay);
    };
    c.on('exit', (code, signal) => onGone(code, signal));
    c.on('error', (err) => onGone(null, null, err));
  }

  /** Polls /health until ok: true, or false on error/timeout (then the child is stopped). */
  async function waitReady() {
    const until = Date.now() + readyTimeoutMs;
    while (!stopping) {
      if (st.state === 'error') return false;
      if (st.state === 'ready') return true;
      const p = await probe();
      if (stopping) return false;
      if (p === 'ok') {
        set({ state: 'ready' });
        return true;
      }
      if (p === 'foreign' && !child) {
        set({ state: 'error', error: `port ${port} is used by another program` });
        return false;
      }
      if (Date.now() > until) {
        set({ state: 'error', error: `llama-server not ready after ${Math.round(readyTimeoutMs / 1000)} s` });
        killChild();
        return false;
      }
      await new Promise((r) => setTimeout(r, healthIntervalMs));
    }
    return false;
  }

  function killChild() {
    const c = child;
    child = null;
    if (!c) return;
    try { c.kill(); } catch { /* already gone */ }
    const hard = setTimeout(() => { if (c.exitCode == null && c.signalCode == null) try { c.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    hard.unref?.();
  }

  async function start(download) {
    stopping = false;
    if (child) return waitReady(); // ours, running or restarting
    if (restartTimer) return waitReady();
    const p = await probe();
    if (p === 'ok' || p === 'loading') {
      set({ external: true, state: p === 'ok' ? 'ready' : 'starting' });
      return p === 'ok' ? true : waitReady();
    }
    if (p === 'foreign') {
      set({ external: false, state: 'error', error: `port ${port} is used by another program` });
      return false;
    }
    st.external = false;
    let { found, model, mmproj } = findAll();
    if (!found || !model || !mmproj) {
      if (!download) {
        set({ state: 'missing' });
        return false;
      }
      const items = [];
      const picked = found ? null : await chooseAssets();
      fs.mkdirSync(lfmDir, { recursive: true });
      fs.mkdirSync(modelsDir, { recursive: true });
      const dl = path.join(lfmDir, 'downloads');
      fs.mkdirSync(dl, { recursive: true });
      if (picked) {
        items.push({ name: picked.asset, url: `${RELEASE_URL}/${picked.asset}`, dest: path.join(dl, picked.asset) });
        if (picked.cudart) items.push({ name: picked.cudart, url: `${RELEASE_URL}/${picked.cudart}`, dest: path.join(dl, picked.cudart) });
      }
      if (!model) items.push({ name: LFM_MODEL_FILE, url: `${MODEL_URL}/${LFM_MODEL_FILE}`, dest: path.join(modelsDir, LFM_MODEL_FILE) });
      if (!mmproj) items.push({ name: LFM_MMPROJ_FILE, url: `${MODEL_URL}/${LFM_MMPROJ_FILE}`, dest: path.join(modelsDir, LFM_MMPROJ_FILE) });
      // A finished download from an earlier run that wasn't installed yet: no need to fetch it again.
      const todo = items.filter((it) => !isFile(it.dest));
      if (todo.length) await downloadAll(todo);
      if (stopping) return false;
      if (picked) {
        set({ state: 'starting' });
        await installLlama(items[0].dest, picked.cudart ? items[1].dest : null, picked.asset);
      }
      ({ found, model, mmproj } = findAll());
      if (!found || !model || !mmproj) throw new Error('llama-server or the model is still missing after the download');
    }
    if (stopping) return false;
    set({ state: 'starting' });
    restarts = 0;
    const ngl = await offloadFlag(found);
    startChild({ bin: found.bin, args: ['-m', model, '-mm', mmproj, '--host', '127.0.0.1', '--port', String(port), '--jinja'], ngl });
    return waitReady();
  }

  function ensure({ download = true } = {}) {
    if (st.state === 'ready' && child) return Promise.resolve(true);
    if (!inflight) {
      inflight = start(download)
        .catch((e) => {
          if (stopping) return false;
          set({ state: 'error', error: e.message });
          log(`[LFM] ${e.message}`);
          return false;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  function stop() {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    abort?.abort();
    killChild();
    const wasExternal = st.external;
    st.external = false;
    set({ state: installed() ? 'idle' : 'missing', external: false });
    if (wasExternal) log('[LFM] stop(): the running server was not started by Jarvis, left as it is');
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  st.state = installed() ? 'idle' : 'missing';
  return { status, installed, ensure, stop, onChange };
}

// Children of every runtime, killed when the backend process exits.
const OWN_CHILDREN = new Set();
let exitHooked = false;
function trackChild(c) {
  OWN_CHILDREN.add(c);
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const k of OWN_CHILDREN) { try { k.kill(); } catch { /* gone */ } }
  });
}
function untrackChild(c) {
  OWN_CHILDREN.delete(c);
}
