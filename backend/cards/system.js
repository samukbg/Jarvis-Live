// System diagnostics: live readings of the machine running this backend.
import os from 'os';
import si from 'systeminformation';
import { cached, compact, round } from './util.js';

const GB = 1024 ** 3;
// The first networkStats() call has no rates; prime it so the card gets real ones.
si.networkStats().catch(() => {});

export function pickDisks(fsList, platform = process.platform) {
  const real = (fsList ?? []).filter((d) => d.size > 5 * GB);
  if (platform === 'darwin') {
    // APFS: the Data volume holds what the user fills; "/" is the sealed system snapshot.
    const data = real.find((d) => d.mount === '/System/Volumes/Data') ?? real.find((d) => d.mount === '/');
    const external = real.filter((d) => d.mount.startsWith('/Volumes/'));
    return [data, ...external].filter(Boolean).slice(0, 3);
  }
  const seen = new Set();
  return real.filter((d) => (seen.has(d.fs) ? false : seen.add(d.fs))).slice(0, 3);
}

const fmtMem = (bytes) => (bytes >= GB ? `${round(bytes / GB, 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

export async function readSystem() {
  const [load, cpu, temp, mem, fs, net, procs, gfx, battery, time] = await Promise.all([
    si.currentLoad(),
    cached('sys:cpu', 3600e3, () => si.cpu()),
    si.cpuTemperature().catch(() => ({})),
    si.mem(),
    cached('sys:fs', 30e3, () => si.fsSize()),
    si.networkStats().catch(() => []),
    cached('sys:procs', 4e3, () => si.processes()),
    cached('sys:gfx', 30e3, () => si.graphics()).catch(() => ({ controllers: [] })),
    cached('sys:battery', 30e3, () => si.battery()).catch(() => ({})),
    si.time(),
  ]);
  const disks = pickDisks(fs).map((d) => ({ mount: d.mount === '/System/Volumes/Data' ? 'Macintosh HD' : d.mount, usedGB: round(d.used / GB, 1), totalGB: round(d.size / GB, 1) }));
  const iface = net.find((n) => n.operstate === 'up' && Number.isFinite(n.rx_sec)) ?? net[0];
  const gpu = gfx.controllers?.find((c) => c.utilizationGpu !== undefined) ?? gfx.controllers?.[0];
  const top = (procs.list ?? [])
    .filter((p) => p.cpu > 0 || p.memRss > 0)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 6)
    .map((p) => ({ name: p.name, cpu: round(p.cpu, 1), memory: fmtMem((p.memRss ?? 0) * 1024) }));
  return compact({
    hostname: os.hostname().replace(/\.local$/, ''),
    os: `${os.type() === 'Darwin' ? 'macOS' : os.type()} ${os.release()}`,
    uptimeHours: round(time.uptime / 3600, 1),
    cpuModel: [cpu.manufacturer, cpu.brand].filter(Boolean).join(' '),
    cpuUsage: round(load.currentLoad),
    cpuCores: cpu.cores,
    coreLoads: (load.cpus ?? []).map((c) => round(c.load)),
    cpuTemp: round(temp.main),
    gpuModel: gpu?.model,
    gpuUsage: round(gpu?.utilizationGpu),
    gpuTemp: round(gpu?.temperatureGpu),
    vramUsedGB: gpu?.memoryUsed ? round(gpu.memoryUsed / 1024, 1) : undefined,
    vramTotalGB: gpu?.memoryTotal ? round(gpu.memoryTotal / 1024, 1) : undefined,
    // mem.available is unreliable on Apple Silicon; used/total matches Activity Monitor.
    ramUsedGB: round(mem.used / GB, 1),
    ramTotalGB: round(mem.total / GB, 1),
    swapUsedGB: mem.swapused ? round(mem.swapused / GB, 1) : undefined,
    diskUsedGB: disks[0]?.usedGB,
    diskTotalGB: disks[0]?.totalGB,
    disks,
    networkDownKBps: iface && Number.isFinite(iface.rx_sec) ? round(iface.rx_sec / 1024, 1) : undefined,
    networkUpKBps: iface && Number.isFinite(iface.tx_sec) ? round(iface.tx_sec / 1024, 1) : undefined,
    batteryPercent: battery.hasBattery ? battery.percent : undefined,
    isCharging: battery.hasBattery ? battery.isCharging : undefined,
    topProcesses: top,
  });
}

export async function enrichSystem() {
  const data = await cached('sys:all', 2e3, readSystem);
  return { data, prefer: 'live', sources: [`${data.hostname ?? 'host'} · live`], refreshMs: 3000 };
}
