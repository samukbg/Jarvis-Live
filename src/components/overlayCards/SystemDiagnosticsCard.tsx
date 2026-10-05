import React from 'react';
import { motion } from 'framer-motion';
import { Cpu, MemoryStick, HardDrive, Thermometer, Download, Upload, Battery, BatteryCharging, ListChecks, Columns3, Timer, Repeat, CircuitBoard } from 'lucide-react';
import type { SystemDiagnosticsData } from './types';
import type { CardLive } from './enrichment';
import { CardShell, GrowBar, Reveal, RingGauge, SectionLabel, Stat, StatGrid, fmt, palette } from './kit';
import { Equalizer, LiveDot, ScrubChart, useSamples } from './motion';

const loadColor = (p: number) => (p >= 85 ? palette.danger : p >= 65 ? palette.warning : palette.accent);

const UsageBar: React.FC<{ icon: React.ReactNode; label: string; used: number; total: number; delay: number }> = ({ icon, label, used, total, delay }) => {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const c = loadColor(pct);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[16px] font-semibold" style={{ color: c }}>{icon}<span className="text-slate-100">{label}</span></div>
        <span className="text-[13px] font-semibold tabular-nums" style={{ color: c }}>{fmt(pct, 0)}%</span>
      </div>
      <GrowBar percent={pct} color={c} height={10} delay={delay} />
      <span className="text-[12px] tabular-nums text-slate-400">{fmt(used, 1)} GB of {fmt(total, 1)} GB · {fmt(Math.max(0, total - used), 1)} GB free</span>
    </div>
  );
};

/** Real samples collected while the card is open (one per live refresh). */
const Trend: React.FC<{ samples: number[]; color: string; label: string; value: string }> = ({ samples, color, label, value }) => (
  <div className="flex flex-col gap-1">
    <div className="flex justify-between text-[11px]">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums text-slate-200">{value}</span>
    </div>
    <ScrubChart values={samples} color={color} height={40} interactive={false} />
  </div>
);

/** Stable per-process key: name + occurrence (several processes can share a name). */
const procKey = (list: Array<{ name: string }>, i: number) => `${list[i].name}#${list.slice(0, i).filter((q) => q.name === list[i].name).length}`;

const uptime = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} days` : `${fmt(h, 0)} h`);

export const SystemDiagnosticsCard: React.FC<{ data: SystemDiagnosticsData; live?: CardLive }> = ({ data, live }) => {
  const cpuSamples = useSamples(data.cpuUsage);
  const downSamples = useSamples(data.networkDownKBps);
  const upSamples = useSamples(data.networkUpKBps);

  const gauges: Array<{ label: string; value: number; temp?: number }> = [];
  if (data.cpuUsage !== undefined) gauges.push({ label: data.cpuCores ? `CPU · ${data.cpuCores} cores` : 'CPU', value: data.cpuUsage, temp: data.cpuTemp });
  if (data.gpuUsage !== undefined) gauges.push({ label: 'GPU', value: data.gpuUsage, temp: data.gpuTemp });
  if (data.ramUsedGB !== undefined && data.ramTotalGB) gauges.push({ label: 'Memory', value: Math.round((data.ramUsedGB / data.ramTotalGB) * 100) });
  const accent = loadColor(Math.max(0, ...gauges.map((g) => g.value)));
  const disks = data.disks?.length ? data.disks : data.diskUsedGB !== undefined && data.diskTotalGB !== undefined ? [{ mount: 'Disk', usedGB: data.diskUsedGB, totalGB: data.diskTotalGB }] : [];

  const extras: Array<[string, string, React.ReactNode]> = [];
  if (data.cpuUsage === undefined && data.cpuTemp !== undefined) extras.push(['CPU temperature', `${data.cpuTemp}°C`, <Thermometer size={13} />]);
  if (data.batteryPercent !== undefined) extras.push(['Battery', `${data.batteryPercent}%${data.isCharging ? ' · charging' : ''}`, data.isCharging ? <BatteryCharging size={13} /> : <Battery size={13} />]);
  if (data.uptimeHours !== undefined) extras.push(['Uptime', uptime(data.uptimeHours), <Timer size={13} />]);
  if (data.swapUsedGB !== undefined) extras.push(['Swap in use', `${fmt(data.swapUsedGB, 1)} GB`, <Repeat size={13} />]);
  if (data.vramUsedGB !== undefined && data.vramTotalGB !== undefined) extras.push(['GPU memory', `${fmt(data.vramUsedGB, 1)} / ${fmt(data.vramTotalGB, 1)} GB`, <CircuitBoard size={13} />]);
  if (cpuSamples.length < 2 && data.networkDownKBps !== undefined) extras.push(['Download', `${fmt(data.networkDownKBps)} KB/s`, <Download size={13} />]);
  if (cpuSamples.length < 2 && data.networkUpKBps !== undefined) extras.push(['Upload', `${fmt(data.networkUpKBps)} KB/s`, <Upload size={13} />]);

  return (
    <CardShell accent={accent}>
      {(data.hostname || data.cpuModel) && (
        <div>
          <Reveal index={0} className="flex items-center gap-3">
            <div>
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border" style={{ borderColor: `${accent}66`, background: `${accent}1A`, boxShadow: `0 0 24px ${accent}33` }}>
                <Cpu size={24} style={{ color: accent }} />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[17px] font-semibold">{data.hostname ?? 'This machine'}</div>
              <div className="truncate text-[12px] text-slate-400">{[data.cpuModel, data.os].filter(Boolean).join(' · ')}</div>
            </div>
            {live?.live && (
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                <LiveDot color={palette.success} size={6} /> Live
              </span>
            )}
          </Reveal>
        </div>
      )}

      {gauges.length > 0 && (
        <Reveal index={1} className="flex justify-around gap-2">
          {gauges.map((g) => (
            <div key={g.label} className="flex flex-col items-center gap-1">
              <RingGauge percent={g.value} color={loadColor(g.value)} size={gauges.length > 2 ? 94 : 108} />
              <span className="text-[13px] font-medium">{g.label}</span>
              {g.temp !== undefined && (
                <span className="flex items-center gap-1 text-[11px] tabular-nums text-slate-400">
                  <Thermometer size={12} className={g.temp >= 80 ? 'text-red-400' : ''} />{g.temp}°C
                </span>
              )}
            </div>
          ))}
        </Reveal>
      )}

      {data.coreLoads && data.coreLoads.length > 1 && (
        <Reveal index={2}>
          <SectionLabel icon={<Columns3 size={13} style={{ color: accent }} />}>{`Per-core load · ${data.coreLoads.length} cores`}</SectionLabel>
          <Equalizer values={data.coreLoads} color={loadColor} />
        </Reveal>
      )}

      {(cpuSamples.length >= 2 || downSamples.length >= 2) && (
        <Reveal index={3} className="grid gap-3 sm:grid-cols-3">
          {cpuSamples.length >= 2 && <Trend samples={cpuSamples} color={accent} label="CPU · since opened" value={`${fmt(data.cpuUsage ?? 0, 0)}%`} />}
          {downSamples.length >= 2 && <Trend samples={downSamples} color={palette.success} label="Download" value={`${fmt(data.networkDownKBps ?? 0, 0)} KB/s`} />}
          {upSamples.length >= 2 && <Trend samples={upSamples} color={palette.violet} label="Upload" value={`${fmt(data.networkUpKBps ?? 0, 0)} KB/s`} />}
        </Reveal>
      )}

      {((data.ramUsedGB !== undefined && data.ramTotalGB !== undefined) || disks.length > 0) && (
        <Reveal index={4} className="flex flex-col gap-4">
          {data.ramUsedGB !== undefined && data.ramTotalGB !== undefined && (
            <UsageBar icon={<MemoryStick size={16} />} label="Memory" used={data.ramUsedGB} total={data.ramTotalGB} delay={0.2} />
          )}
          {disks.map((d, i) => <UsageBar key={d.mount} icon={<HardDrive size={16} />} label={d.mount} used={d.usedGB} total={d.totalGB} delay={0.32 + i * 0.1} />)}
        </Reveal>
      )}

      {extras.length > 0 && (
        <Reveal index={5}>
          <StatGrid>
            {extras.map(([label, value, icon]) => <Stat key={label} label={label} icon={<span style={{ color: accent }}>{icon}</span>}>{value}</Stat>)}
          </StatGrid>
        </Reveal>
      )}

      {data.topProcesses && data.topProcesses.length > 0 && (
        <Reveal index={6}>
          <SectionLabel icon={<ListChecks size={13} style={{ color: accent }} />}>Top processes</SectionLabel>
          <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-500">
            <span className="w-4">#</span><span className="flex-1">Process</span><span className="w-14 text-right">CPU</span><span className="w-16 text-right">Memory</span>
          </div>
          <div className="flex flex-col gap-3">
            {data.topProcesses.map((p, i) => (
              // Keyed by name so rows glide to their new rank as live readings change.
              <motion.div key={procKey(data.topProcesses!, i)} layout transition={{ type: 'spring', damping: 20, stiffness: 200 }} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-[14px]">
                  <span className="w-4 text-[11px] text-slate-500">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="w-14 text-right text-[13px] tabular-nums" style={{ color: loadColor(p.cpu) }}>{fmt(p.cpu, 1)}%</span>
                  <span className="w-16 text-right text-[13px] tabular-nums text-slate-400">{p.memory}</span>
                </div>
                <GrowBar percent={Math.min(100, p.cpu)} color={loadColor(p.cpu)} height={5} delay={i * 0.06} />
              </motion.div>
            ))}
          </div>
        </Reveal>
      )}
    </CardShell>
  );
};
