// The Command screen's side panels (mobile AgentsCarousel, ActivityPanel, SystemPanel,
// FeedPanel, QuickActions, WorldClocks) — same content and motion, laid out for a desktop.
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle, AlertTriangle, Bell, Bot, Brush, CheckCircle2, Cpu, DatabaseZap, Download, ExternalLink, GitPullRequest,
  Heart, Info, MessageSquareText, Music, Newspaper, Pause, Play, RotateCw, SkipBack, SkipForward, TrendingDown, TrendingUp,
  Volume2, Wallet, Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore, API_KEY, type Agent } from '../../store';
import { Meter, Pressable, SectionHeader, SegmentedControl, StatusDot, alpha, palette, spring } from '../../ui';
import { agentMeta, agentStatus, classifyLog, type LogEntry } from '../../shell/status';

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// ── Agents ───────────────────────────────────────────────────────────────────
function AgentCard({ agent, index }: { agent: Agent; index: number }) {
  const meta = agentMeta(agent.id);
  const st = agentStatus(agent.status);
  const Icon = meta.icon;
  return (
    <motion.div initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring.gentle, delay: 0.08 + index * 0.06 }}>
      <Pressable
        pressedScale={0.97}
        whileHover={{ y: -3 }}
        onClick={() => useStore.setState({
          agentOutcome: {
            agentId: agent.id,
            agentName: titleCase(agent.name),
            result: `**Status:** ${st.label}\n\n${agent.description || agent.role}${agent.prompt ? `\n\n**Current task:** ${agent.prompt}` : ''}`,
          },
        })}
        aria-label={`${agent.name}, ${st.label}`}
        className="flex w-full flex-col gap-1 rounded-[20px] border p-3.5 text-left transition-colors"
        style={st.busy ? { background: alpha(st.color, 18), borderColor: alpha(st.color, 112) } : { background: palette.surface, borderColor: palette.stroke }}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="grid h-9 w-9 place-items-center rounded-[10px]" style={{ background: alpha(meta.color, 34), color: meta.color }}><Icon size={17} /></span>
          <span className="flex h-[22px] items-center gap-1.5 rounded-full px-2" style={{ background: alpha(st.color, 31) }}>
            <StatusDot color={st.color} pulse={st.busy} size={6} />
            <span className="t-caption" style={{ color: st.busy || agent.status === 'ERROR' ? st.color : palette.textSecondary }}>{st.label}</span>
          </span>
        </div>
        <span className="t-headline truncate">{titleCase(agent.name)}</span>
        <span className="t-footnote truncate" style={{ color: palette.textSecondary }}>{agent.role}</span>
      </Pressable>
    </motion.div>
  );
}

export function AgentsPanel() {
  const all = useStore((s) => s.agents);
  const agents = useMemo(() => all.filter((a) => a.id !== 'jarvis'), [all]);
  const busy = agents.filter((a) => agentStatus(a.status).busy).length;
  return (
    <section>
      <SectionHeader title="Agents" icon={Bot} meta={busy ? `${busy} working` : `${agents.length} ready`} />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
        {agents.map((a, i) => <AgentCard key={a.id} agent={a} index={i} />)}
      </div>
    </section>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────
function Line({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="ml-auto max-w-[86%] rounded-[14px] rounded-br-[4px] px-3 py-2" style={{ background: alpha(palette.accent, 36) }}>
          <div className="t-callout">{entry.text}</div>
          {entry.time && <div className="text-right t-caption" style={{ color: palette.textTertiary }}>{entry.time}</div>}
        </div>
      );
    case 'jarvis':
      return (
        <div className="max-w-[86%] rounded-[14px] rounded-bl-[4px] px-3 py-2" style={{ background: palette.surfaceRaised }}>
          <div className="t-eyebrow" style={{ color: palette.accent }}>Jarvis</div>
          <div className="t-callout">{entry.text}</div>
          {entry.time && <div className="t-caption" style={{ color: palette.textTertiary }}>{entry.time}</div>}
        </div>
      );
    case 'alert':
      return (
        <div className="flex items-start gap-2 rounded-[10px] p-2" style={{ background: alpha(palette.listening, 40) }}>
          <AlertCircle size={15} className="mt-0.5 shrink-0" style={{ color: palette.listening }} />
          <span className="t-footnote" style={{ color: palette.listening }}>{entry.tag ? `${entry.tag} · ` : ''}{entry.text}</span>
        </div>
      );
    default:
      return (
        <div className="flex items-baseline gap-2 px-0.5">
          <span className="w-10 shrink-0 tabular t-caption" style={{ color: palette.textTertiary }}>{entry.time}</span>
          <span className="t-footnote line-clamp-3" style={{ color: palette.textSecondary }}>
            {entry.tag && <span style={{ color: palette.textTertiary }}>{entry.tag} · </span>}{entry.text}
          </span>
        </div>
      );
  }
}

function ActivityPanel() {
  const logs = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const voiceState = useStore((s) => s.voiceState);
  const entries = useMemo(() => logs.slice(-80).map(classifyLog), [logs]);
  // Follow the newest line inside the list only (scrollIntoView would scroll the whole screen too).
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = list.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [logs, voiceState.transcript]);
  return (
    <div className="surface flex h-[420px] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: palette.stroke }}>
        <span className="t-footnote" style={{ color: palette.textTertiary }}>{entries.length ? `${entries.length} recent events` : 'No activity yet'}</span>
        {entries.length > 0 && (
          <Pressable onClick={clearLogs} className="flex items-center gap-1 t-footnote" style={{ color: palette.textSecondary }}>
            <Brush size={13} /> Clear
          </Pressable>
        )}
      </div>
      <div ref={list} className="flex flex-1 flex-col gap-2 overflow-y-auto p-3 scrollbar-thin">
        <AnimatePresence initial={false}>
          {entries.map((e, i) => (
            <motion.div key={`${i}-${e.time}-${e.text.length}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
              <Line entry={e} />
            </motion.div>
          ))}
        </AnimatePresence>
        {voiceState.isListening && voiceState.role === 'user' && voiceState.transcript && (
          <div className="ml-auto max-w-[86%] rounded-[14px] rounded-br-[4px] border px-3 py-2"
            style={{ background: alpha(palette.listening, 40), borderColor: alpha(palette.listening, 102) }}>
            <span className="t-callout">{voiceState.transcript}</span>
            <motion.span className="ml-0.5 inline-block h-3.5 w-[2px] align-middle" style={{ background: palette.listening }}
              animate={{ opacity: [1, 0, 1] }} transition={{ duration: 0.8, repeat: Infinity }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── System ───────────────────────────────────────────────────────────────────
function CardTitle({ icon: Icon, title, color = palette.accent, right }: { icon: typeof Cpu; title: string; color?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="grid h-[30px] w-[30px] place-items-center rounded-[10px]" style={{ background: alpha(color, 34), color }}><Icon size={15} /></span>
      <span className="flex-1 t-headline">{title}</span>
      {right}
    </div>
  );
}

function Gauge({ label, value, warnAt, warnColor }: { label: string; value: number | null; warnAt: number; warnColor: string }) {
  const v = value ?? 0;
  const color = v > warnAt ? warnColor : palette.accent;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="t-subhead" style={{ color: palette.textSecondary }}>{label}</span>
        <span className="t-headline tabular" style={{ color }}>{value === null ? '—' : `${Math.round(v)}%`}</span>
      </div>
      <Meter value={v} color={color} />
    </div>
  );
}

function SystemPanel() {
  const telemetry = useStore((s) => s.telemetry);
  const crypto = useStore((s) => s.crypto);
  const spotify = useStore((s) => s.spotify);
  const spotifyAction = useStore((s) => s.spotifyAction);
  const health = useStore((s) => s.health);
  const activeServerUrl = useStore((s) => s.activeServerUrl);
  const [volume, setVolume] = useState(80);
  const change = Number(crypto?.ethChange ?? 0);
  const playing = spotify.state === 'playing';
  useEffect(() => {
    if (!activeServerUrl) return;
    fetch(`${activeServerUrl}/api/spotify/state?api_key=${encodeURIComponent(API_KEY)}`)
      .then((r) => r.json()).then((d) => { if (d.state !== undefined) useStore.setState({ spotify: d }); }).catch(() => {});
  }, [activeServerUrl]);

  return (
    <div className="flex flex-col gap-3">
      <div className="surface p-4">
        <CardTitle icon={Cpu} title="Workstation" />
        <div className="flex flex-col gap-4">
          <Gauge label="CPU" value={telemetry.cpu} warnAt={80} warnColor={palette.listening} />
          <Gauge label="Memory" value={telemetry.ram} warnAt={80} warnColor={palette.warning} />
        </div>
      </div>

      <div className="surface relative overflow-hidden p-4" style={{ background: `linear-gradient(160deg, ${alpha(palette.success, 22)}, ${palette.surface} 55%)`, borderColor: alpha(palette.success, 40) }}>
        <CardTitle icon={Wallet} title="Base wallet" color={palette.success} />
        {crypto ? (
          <>
            <div className="t-display tabular">{crypto.balanceBase} <span className="t-title2" style={{ color: palette.textSecondary }}>ETH</span></div>
            <div className="my-2 flex items-center justify-between">
              <span className="t-callout tabular" style={{ color: palette.textSecondary }}>${Number(crypto.totalUsd).toLocaleString()}</span>
              <span className="flex items-center gap-1 rounded-full px-2 py-0.5 t-subhead tabular"
                style={{ background: alpha(change >= 0 ? palette.success : palette.listening, 34), color: change >= 0 ? palette.success : palette.listening }}>
                {change >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}{change >= 0 ? '+' : ''}{crypto.ethChange}% 24h
              </span>
            </div>
            <div className="truncate t-caption" style={{ color: palette.textTertiary }}>{crypto.address}</div>
          </>
        ) : <div className="t-callout" style={{ color: palette.textTertiary }}>Syncing Base chain data…</div>}
      </div>

      <div className="surface p-4">
        <CardTitle icon={Music} title="Now playing" />
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="t-headline truncate">{spotify.track || 'Nothing playing'}</div>
            <div className="t-footnote truncate" style={{ color: palette.textSecondary }}>{spotify.artist || 'Ask Jarvis to play something'}</div>
          </div>
          <Pressable aria-label="Previous track" onClick={() => spotifyAction('prev')} className="grid h-9 w-9 place-items-center rounded-full" style={{ background: palette.surfaceRaised }}><SkipBack size={16} /></Pressable>
          <Pressable aria-label={playing ? 'Pause' : 'Play'} onClick={() => spotifyAction(playing ? 'pause' : 'play')} className="grid h-11 w-11 place-items-center rounded-full" style={{ background: palette.accent, color: palette.textInverse }}>
            {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
          </Pressable>
          <Pressable aria-label="Next track" onClick={() => spotifyAction('next')} className="grid h-9 w-9 place-items-center rounded-full" style={{ background: palette.surfaceRaised }}><SkipForward size={16} /></Pressable>
        </div>
        <label className="mt-3 flex items-center gap-2" style={{ color: palette.textTertiary }}>
          <Volume2 size={14} />
          <input type="range" min={0} max={100} value={volume} aria-label="Volume" className="flex-1"
            onChange={(e) => { const v = Number(e.target.value); setVolume(v); spotifyAction('volume', v); }} />
        </label>
      </div>

      <div className="surface p-4">
        <CardTitle icon={Heart} title="Biometrics" color={palette.listening}
          right={health.connected && <span className="t-caption" style={{ color: palette.success }}>Synced {health.synced_at ? new Date(health.synced_at).toLocaleDateString() : ''}</span>} />
        {health.connected ? (
          <div className="grid grid-cols-3 gap-3">
            {[
              ['Recovery', `${health.recovery}%`], ['Sleep', `${health.sleep} h`], ['HRV', `${health.hrv} ms`],
              ['Resting HR', `${health.rhr} bpm`], ['Strain', `${health.strain}`], ['Steps', `${health.steps?.toLocaleString()}`],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="t-headline tabular">{value}</div>
                <div className="t-caption" style={{ color: palette.textTertiary }}>{label}</div>
              </div>
            ))}
          </div>
        ) : <div className="t-footnote" style={{ color: palette.textTertiary }}>Export Apple Health with a Shortcut to health_export.json to see recovery, sleep and HRV here.</div>}
      </div>
    </div>
  );
}

// ── Feed & alerts ────────────────────────────────────────────────────────────
const TAG_COLOR: Record<string, string> = { AI: palette.accent, POLITICS: palette.warning, WORLD: palette.violet, TECH: palette.gemini };

function FeedPanel() {
  const feed = useStore((s) => s.feed);
  if (!feed.length) {
    return (
      <div className="surface flex flex-col items-center gap-2 py-10" style={{ color: palette.textTertiary }}>
        <Newspaper size={26} /><span className="t-callout">Your intelligence feed will appear here.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {feed.slice(0, 10).map((item, i) => {
        const c = TAG_COLOR[item.tag] ?? palette.accent;
        return (
          <motion.a key={`${item.link}-${i}`} href={item.link || undefined} target="_blank" rel="noopener noreferrer"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.26 }}
            whileHover={{ y: -2 }} className="surface group flex flex-col gap-2 p-3.5 no-underline" style={{ borderRadius: 14 }}>
            <div className="flex items-center gap-2">
              <span className="rounded-full px-2 py-0.5 t-caption" style={{ background: alpha(c, 36), color: c }}>{item.tag ? titleCase(item.tag) : 'AI'}</span>
              <span className="flex-1 truncate t-caption" style={{ color: palette.textTertiary }}>{item.source}{item.time ? ` · ${item.time}` : ''}</span>
              <ExternalLink size={13} className="opacity-0 transition-opacity group-hover:opacity-100" style={{ color: palette.textTertiary }} />
            </div>
            <span className="t-callout line-clamp-2" style={{ color: palette.text }}>{item.title}</span>
          </motion.a>
        );
      })}
    </div>
  );
}

function AlertsPanel() {
  const notifications = useStore((s) => s.notifications);
  if (!notifications.length) {
    return (
      <div className="surface flex flex-col items-center gap-2 py-10" style={{ color: palette.textTertiary }}>
        <Bell size={26} /><span className="t-callout">No notifications yet.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {notifications.map((n) => {
          const c = n.kind === 'warn' ? palette.warning : n.kind === 'success' ? palette.success : palette.accent;
          const Icon = n.kind === 'warn' ? AlertTriangle : n.kind === 'success' ? CheckCircle2 : Info;
          return (
            <motion.div key={n.id} layout initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={spring.gentle}
              className="surface flex gap-3 p-3.5" style={{ borderRadius: 14 }}>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px]" style={{ background: alpha(c, 34), color: c }}><Icon size={15} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="t-subhead" style={{ color: c }}>{titleCase(n.label)}</span>
                  <span className="t-caption tabular" style={{ color: palette.textTertiary }}>{n.time}</span>
                </div>
                <div className="t-footnote" style={{ color: palette.textSecondary }}>{n.msg}</div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

type InfoTab = 'activity' | 'system' | 'feed' | 'alerts';

export function InfoTabs() {
  const [tab, setTab] = useState<InfoTab>('activity');
  const unread = useStore((s) => s.notifications.length);
  return (
    <section className="flex flex-col gap-3">
      <SegmentedControl<InfoTab>
        label="Panels"
        value={tab}
        onChange={setTab}
        segments={[
          { key: 'activity', label: 'Activity', icon: MessageSquareText },
          { key: 'system', label: 'System', icon: Cpu },
          { key: 'feed', label: 'Feed', icon: Newspaper },
          { key: 'alerts', label: unread ? `Alerts · ${unread}` : 'Alerts', icon: Bell },
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
          {tab === 'activity' && <ActivityPanel />}
          {tab === 'system' && <SystemPanel />}
          {tab === 'feed' && <FeedPanel />}
          {tab === 'alerts' && <AlertsPanel />}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

// ── Quick actions & clocks ───────────────────────────────────────────────────
const ACTIONS = [
  { key: 'flush-cache', label: 'Flush cache', desc: 'Purge model cache', icon: DatabaseZap, color: palette.accent },
  { key: 'reboot-nodes', label: 'Reboot nodes', desc: 'Restart services', icon: RotateCw, color: palette.warning },
  { key: 'sync-repo', label: 'Sync repo', desc: 'Pull latest code', icon: GitPullRequest, color: palette.success },
  { key: 'download-logs', label: 'Download logs', desc: 'Export backend.log', icon: Download, color: palette.gemini },
  { key: 'wipe-terminal', label: 'Wipe logs', desc: 'Clear activity', icon: Brush, color: palette.violet },
];

export function QuickActions() {
  const quickAction = useStore((s) => s.quickAction);
  return (
    <section>
      <SectionHeader title="Quick actions" icon={Zap} />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {ACTIONS.map((a, i) => {
          const Icon = a.icon;
          return (
            <motion.div key={a.key} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.gentle, delay: 0.1 + i * 0.05 }}>
              <Pressable onClick={() => quickAction(a.key)} whileHover={{ y: -3 }} aria-label={a.label}
                className="surface flex w-full flex-col gap-0.5 p-3.5 text-left transition-colors hover:border-[rgba(148,210,255,0.24)]">
                <span className="mb-2 grid h-[38px] w-[38px] place-items-center rounded-[14px]" style={{ background: alpha(a.color, 34), color: a.color }}><Icon size={18} /></span>
                <span className="t-headline truncate">{a.label}</span>
                <span className="t-footnote truncate" style={{ color: palette.textSecondary }}>{a.desc}</span>
              </Pressable>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

const CITIES = [
  { name: 'Mumbai', tz: 'Asia/Kolkata' },
  { name: 'London', tz: 'Europe/London' },
  { name: 'Paris', tz: 'Europe/Paris' },
  { name: 'New York', tz: 'America/New_York' },
];
const fmt = (tz: string, d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

export function WorldClocks() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(id); }, []);
  return (
    <div className="surface grid grid-cols-4 py-3.5">
      {CITIES.map((c) => (
        <div key={c.name} className="flex flex-col items-center gap-0.5">
          <span className="t-title2 tabular">{fmt(c.tz, now)}</span>
          <span className="t-caption" style={{ color: palette.textTertiary }}>{c.name}</span>
        </div>
      ))}
    </div>
  );
}
