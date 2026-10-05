// Hardware and session status of this Jarvis server: whether it has room for a new
// avatar session (GET /api/server/status).
import os from 'node:os';

const CACHE_MS = 3000;

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits` → GPUs. */
export function parseNvidiaSmi(csv) {
  return String(csv || '')
    .split(/\r?\n/)
    .map((line) => line.split(',').map((s) => s.trim()))
    .filter((cols) => cols.length >= 4 && cols[0])
    .map(([name, util, used, total, temp]) => ({
      name,
      utilizationPct: Number(util),
      memoryUsedMB: Number(used),
      memoryTotalMB: Number(total),
      memoryFreeMB: Number(total) - Number(used),
      temperatureC: temp === undefined || temp === '' ? null : Number(temp),
    }))
    .filter((g) => Number.isFinite(g.memoryTotalMB));
}

/**
 * Whether this server should take a new session.
 * - the avatar pipeline (streamer + renderer) is up and its single session slot is free;
 * - the GPU has `minFreeVramMB` free and is under `maxGpuUtilPct` busy (other apps on the
 *   same GPU — video generation, emulators — made the avatar lag).
 */
export function assessCapacity(status, { minFreeVramMB = 4000, maxGpuUtilPct = 85 } = {}) {
  const reasons = [];
  const install = status.avatar.install;
  // Not installed explains "down" better: say what's missing.
  if (install && !install.streamerEnv) reasons.push('live avatar not installed: streamer_win_env missing');
  else if (!status.avatar.streamer) reasons.push('avatar streamer down');
  if (install && !install.renderer) reasons.push(`live avatar not installed: no /root/avtr-1 in WSL ${install.wslDistro || ''}`.trim());
  else if (!status.avatar.renderer) reasons.push('avatar renderer down');
  if (status.avatar.sessionBusy) reasons.push('avatar session in use');
  const gpu = status.gpus[0];
  if (!gpu) reasons.push('no NVIDIA GPU detected');
  else {
    if (gpu.memoryFreeMB < minFreeVramMB) reasons.push(`only ${gpu.memoryFreeMB} MB VRAM free`);
    if (gpu.utilizationPct > maxGpuUtilPct) reasons.push(`GPU ${gpu.utilizationPct}% busy`);
  }
  return { accepting: reasons.length === 0, reasons };
}

/**
 * @param install  optional () => ({ streamerEnv, wslDistro, renderer }) — what's installed
 *                 for the live avatar (checked rarely: WSL paths are slow to probe).
 */
export function createStatusCollector({ name, version, exec, fetchStreamer, cpuLoadPct, limits, install, installTtlMs = 60_000 } = {}) {
  let installCache = null;
  let installAt = 0;
  const installed = () => {
    if (!install) return undefined;
    if (!installCache || Date.now() - installAt > installTtlMs) {
      try { installCache = install(); } catch { installCache = undefined; }
      installAt = Date.now();
    }
    return installCache;
  };
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  async function gpus() {
    try {
      const { stdout } = await exec('nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits', { timeout: 5000 });
      return parseNvidiaSmi(stdout);
    } catch {
      return [];
    }
  }

  async function avatar() {
    const state = { streamer: false, renderer: false, sessionBusy: false, sessionSince: null };
    try {
      const r = await fetchStreamer('/session-status', { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const s = await r.json();
        state.streamer = true;
        state.sessionBusy = !!s.busy;
        state.sessionSince = s.since ?? null;
      }
    } catch {}
    if (state.streamer) {
      try {
        const r = await fetchStreamer('/debug/latency', { signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        state.renderer = !d?.renderer?.error;
      } catch {}
    }
    return state;
  }

  async function collect() {
    const [g, a, cpu] = await Promise.all([gpus(), avatar(), Promise.resolve(cpuLoadPct?.()).catch(() => null)]);
    const status = {
      name,
      version,
      time: new Date().toISOString(),
      gpus: g,
      cpu: { cores: os.cpus().length, loadPct: cpu ?? null },
      memory: { totalMB: Math.round(os.totalmem() / 2 ** 20), freeMB: Math.round(os.freemem() / 2 ** 20) },
      avatar: install ? { ...a, install: installed() } : a,
    };
    return { ...status, capacity: assessCapacity(status, limits) };
  }

  /** Cached for a few seconds: clients may poll it often. */
  return async function serverStatus() {
    if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
    inflight ??= collect().finally(() => { inflight = null; });
    cached = await inflight;
    cachedAt = Date.now();
    return cached;
  };
}
