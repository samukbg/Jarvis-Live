// Shared status logic (the mobile app's shell/voiceStatus, agents and classifyLog).
import { Asterisk, Bot, Braces, Factory, Rocket, Shield, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import { useStore, type Agent } from '../store';
import { palette } from '../ui/theme';

export interface VoiceStatus { label: string; color: string; pulse: boolean }

/** Connection + voice state → the status shown everywhere (header, stage, dock). */
export function voiceStatus(o: { connected: boolean; isListening: boolean; isSpeaking: boolean; isDelegating: boolean }): VoiceStatus {
  if (!o.connected) return { label: 'Offline', color: palette.muted, pulse: false };
  if (o.isListening) return { label: 'Listening', color: palette.listening, pulse: true };
  if (o.isSpeaking) return { label: 'Speaking', color: palette.accent, pulse: true };
  if (o.isDelegating) return { label: 'Working with agents', color: palette.violet, pulse: true };
  return { label: 'Online', color: palette.success, pulse: false };
}

/** True while any worker agent (not the Jarvis core) is busy. */
export const useIsDelegating = () =>
  useStore((s) => s.agents.some((a) => ['agy', 'claude', 'hermes', 'codex', 'openclaw'].includes(a.id) && a.status !== 'IDLE'));

export const useVoiceStatus = () => {
  const connected = useStore((s) => s.wsConnected);
  const isListening = useStore((s) => s.voiceState.isListening);
  const isSpeaking = useStore((s) => s.voiceState.isSpeaking);
  const isDelegating = useIsDelegating();
  return voiceStatus({ connected, isListening, isSpeaking, isDelegating });
};

export const AGENT_META: Record<string, { icon: LucideIcon; color: string }> = {
  jarvis: { icon: Shield, color: palette.accent },
  hermes: { icon: Zap, color: '#FACC15' },
  gemini: { icon: Sparkles, color: palette.gemini },
  claude: { icon: Asterisk, color: '#F0885C' },
  agy: { icon: Rocket, color: palette.violet },
  codex: { icon: Braces, color: '#10A37F' },
  openclaw: { icon: Factory, color: '#F97316' },
};
export const agentMeta = (id: string) => AGENT_META[id] ?? { icon: Bot, color: palette.accent };

export const agentStatus = (status: Agent['status']) => {
  switch (status) {
    case 'THINKING': return { label: 'Thinking', color: palette.warning, busy: true };
    case 'WRITING': return { label: 'Writing', color: palette.accent, busy: true };
    case 'ERROR': return { label: 'Error', color: palette.listening, busy: false };
    default: return { label: 'Idle', color: palette.muted, busy: false };
  }
};

export interface Provider { key: string; label: string; color: string; icon: LucideIcon }
const PROVIDER_STYLE: Record<string, { color: string; icon: LucideIcon }> = {
  gemini: { color: palette.gemini, icon: Sparkles },
  hermes: { color: palette.accent, icon: Zap },
  claude: { color: palette.claude, icon: Asterisk },
  codex: { color: '#10A37F', icon: Braces },
  openclaw: { color: '#F97316', icon: Factory },
};
/** The agents this server has, as picker entries (Gemini drives Antigravity). */
export const providersFor = (agents: { id: string; name: string }[]): Provider[] =>
  agents.map((a) => ({ key: a.id, label: a.id === 'gemini' ? 'Antigravity' : a.name, ...(PROVIDER_STYLE[a.id] ?? { color: palette.accent, icon: Bot }) }));
export const providerFor = (providers: Provider[], id: string): Provider =>
  providers.find((p) => p.key === id) ?? providers[0] ?? { key: id, label: id ? id[0].toUpperCase() + id.slice(1) : 'Agent', ...(PROVIDER_STYLE[id] ?? { color: palette.accent, icon: Bot }) };

// ── Activity log lines → chat-style entries ──────────────────────────────────
export type LogKind = 'user' | 'jarvis' | 'alert' | 'system';
export interface LogEntry { time: string; kind: LogKind; text: string; tag?: string }
const ALERT_TAGS = /^(ALERT|WARN|VOICE ERR|VOICE START ERR|AUDIO ERR|AVATAR NOTICE|ERROR)$/;
const titleCase = (tag: string) => tag.charAt(0) + tag.slice(1).toLowerCase();

/** "[HH:MM:SS]message" → entry (same rules as the mobile ActivityPanel). */
export function classifyLog(line: string): LogEntry {
  const ts = line.match(/^\[(\d{2}:\d{2})(?::\d{2})?\]/);
  const time = ts ? ts[1] : '';
  const rest = (ts ? line.slice(ts[0].length) : line).trim();
  let m = rest.match(/^>>>\s*(?:You:\s*)?([\s\S]*)$/) || rest.match(/^You:\s*([\s\S]*)$/i) || rest.match(/^\[LIVE AVATAR\]\s*User:\s*([\s\S]*)$/);
  if (m) return { time, kind: 'user', text: m[1] };
  m = rest.match(/^JARVIS:\s*([\s\S]*)$/i) || rest.match(/^\[LIVE AVATAR\]\s*Jarvis:\s*([\s\S]*)$/);
  if (m) return { time, kind: 'jarvis', text: m[1] };
  m = rest.match(/^\[([A-Z0-9 _-]+)\]\s*([\s\S]*)$/);
  if (m) return { time, kind: ALERT_TAGS.test(m[1]) ? 'alert' : 'system', tag: titleCase(m[1]), text: m[2] };
  return { time, kind: 'system', text: rest };
}
