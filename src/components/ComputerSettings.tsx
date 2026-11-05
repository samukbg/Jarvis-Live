// Settings → Live avatar → Avatar server (the server's owner only): your own AVTR-1 server, or the
// server's default streamer. Saved on the server, so every device uses the same one.
import React, { useCallback, useEffect, useState } from 'react';
import { Server, Check, AlertTriangle, Loader2, Mic, type LucideIcon } from 'lucide-react';
import { useStore, API_KEY } from '../store';
import { Pressable, palette, SegmentedControl, alpha } from '../ui';
import { Section } from './SettingsSection';

interface AvatarSource {
  computerName?: string;
  mode: 'cloud' | 'own';
  url: string;
  hasKey: boolean;
  machine: boolean;
  cloudLinked: boolean;
  callbackUrl: string | null;
  reachable?: boolean;
  error?: string;
}


const input = 'w-full rounded-[14px] border border-stroke bg-surface-raised px-4 py-2.5 t-body text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent/70';

function useServerJson<T>(path: string, open: boolean, everyMs = 0) {
  const activeServerUrl = useStore((s) => s.activeServerUrl);
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(() => {
    if (!activeServerUrl) return Promise.resolve();
    return fetch(`${activeServerUrl}${path}`, { headers: { 'x-api-key': API_KEY } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: T | null) => setData(d))
      .catch(() => setData(null));
  }, [activeServerUrl, path]);
  useEffect(() => {
    if (!open || !activeServerUrl) return;
    let alive = true;
    const run = () => fetch(`${activeServerUrl}${path}`, { headers: { 'x-api-key': API_KEY } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: T | null) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); });
    run();
    const t = everyMs ? setInterval(run, everyMs) : undefined;
    return () => { alive = false; clearInterval(t); };
  }, [open, activeServerUrl, path, everyMs]);
  return { data, setData, load, base: activeServerUrl };
}

const Note = ({ tone = 'muted', children }: { tone?: 'muted' | 'ok' | 'warn'; children: React.ReactNode }) => {
  const color = tone === 'ok' ? palette.success : tone === 'warn' ? palette.warning : palette.textTertiary;
  const Icon: LucideIcon | null = tone === 'ok' ? Check : tone === 'warn' ? AlertTriangle : null;
  return (
    <p className="flex items-start gap-1.5 t-footnote" style={{ color }}>
      {Icon && <Icon size={14} className="mt-[2px] shrink-0" />}
      <span>{children}</span>
    </p>
  );
};

const Button = ({ onClick, icon: Icon, children, primary = false, disabled = false }: { onClick: () => void; icon?: LucideIcon; children: React.ReactNode; primary?: boolean; disabled?: boolean }) => (
  <Pressable onClick={onClick} disabled={disabled} className="flex h-9 items-center gap-1.5 rounded-full px-4 t-subhead disabled:opacity-50"
    style={primary ? { background: palette.accent, color: palette.textInverse } : { background: palette.surfaceRaised, color: palette.textSecondary }}>
    {Icon && <Icon size={15} />}{children}
  </Pressable>
);

/** Where the live avatar runs: your own AVTR-1 server, or this server's default streamer. */
export const AvatarServerSection: React.FC<{ open: boolean }> = ({ open }) => {
  const { data: source, setData, base } = useServerJson<AvatarSource>('/api/avatar/source', open);
  if (!source) return null;
  // Keyed by the saved choice: the form starts over from it after each save.
  return <AvatarServerForm key={`${source.mode}|${source.url}`} source={source} onSaved={setData} base={base} />;
};

const AvatarServerForm: React.FC<{ source: AvatarSource; onSaved: (s: AvatarSource) => void; base: string }> = ({ source, onSaved, base }) => {
  const [url, setUrl] = useState(source.url);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = source.mode === 'own';
  const dirty = url.trim() !== source.url || key.trim() !== '';

  const save = async (body: Record<string, string>) => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${base}/api/avatar/source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) setError(d.error || `HTTP ${r.status}`);
      else onSaved(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Live avatar server" aside={<Server size={15} style={{ color: palette.textTertiary }} />}>
      <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:7860 or https://my-gpu-server.com" className={input} />
      <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" className={input}
        placeholder={source.hasKey && url.trim() === source.url ? 'API key saved · type to replace' : 'API key · only if it is another Jarvis server'} />
      <Note>{own
        ? `Your AVTR-1 server (a streamer on port 7860, or another Jarvis server with an NVIDIA GPU). The avatar still runs your agents on ${source.computerName || 'this server'}.`
        : 'Using this server’s default avatar streamer (STREAMER_URL, or one running on this computer). Enter another AVTR-1 server to use it instead.'}</Note>
      {!dirty && own && source.reachable === true && <Note tone="ok">Connected to {source.url}{source.callbackUrl ? ` · it reaches this server at ${source.callbackUrl}` : ''}</Note>}
      {!dirty && own && source.reachable === false && <Note tone="warn">Saved, but {source.error || 'the server did not answer'}.</Note>}
      {!dirty && own && !source.callbackUrl && <Note tone="warn">The avatar server can't reach this server: put both on the same network, or set JARVIS_BACKEND_URL.</Note>}
      {error && <Note tone="warn">{error}</Note>}
      <div className="flex justify-end gap-2">
        {own && <Button onClick={() => save({ mode: 'cloud' })} disabled={saving}>Use the default streamer</Button>}
        <Button primary icon={saving ? Loader2 : Check} onClick={() => save({ mode: 'own', url: url.trim(), key: key.trim() })} disabled={saving || !url.trim() || (own && !dirty)}>
          {saving ? 'Checking…' : 'Use this server'}
        </Button>
      </div>
    </Section>
  );
};

interface VoiceStatus {
  provider: VoiceProvider;
  source: 'own' | 'local' | 'none';
  hasOwnKey: boolean;
  hasOpenAIKey: boolean;
  openaiModel?: string;
  lfmModel?: string;
  lfmUrl?: string;
}

type VoiceProvider = 'lfm' | 'gemini' | 'openai';

/** Where the orb's live voice comes from: LFM Realtime (default), Gemini Live (2nd), OpenAI Realtime (3rd). */
export const VoiceSection: React.FC<{ open: boolean }> = ({ open }) => {
  const { data: voice, setData, base } = useServerJson<VoiceStatus>('/api/voice/status', open);
  if (!voice) return null;
  return <VoiceForm key={`${voice.source}-${voice.provider}`} voice={voice} onSaved={setData} base={base} />;
};

const VoiceForm: React.FC<{ voice: VoiceStatus; onSaved: (v: VoiceStatus) => void; base: string }> = ({ voice, onSaved, base }) => {
  const provider: VoiceProvider = voice.provider || 'lfm';
  const [tab, setTab] = useState<VoiceProvider>(provider);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (path: string, body: object): Promise<VoiceStatus | null> => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };

  const use = (p: VoiceProvider) => {
    setSaving(true);
    setError(null);
    post('/api/voice/provider', { provider: p })
      .then((v) => { if (v) onSaved(v); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setSaving(false));
  };

  const label = provider === 'lfm'
    ? 'Local LFM (llama.cpp)'
    : provider === 'openai' ? 'OpenAI Realtime'
    : voice.source === 'own' ? 'Your Gemini key' : 'Not set up';

  return (
    <Section title="Live Voice" aside={<span className="t-footnote" style={{ color: palette.success }}>{label}</span>}>
      <SegmentedControl<VoiceProvider>
        label="Live voice"
        value={tab}
        onChange={(t) => { setTab(t); setError(null); }}
        segments={[
          { key: 'lfm', label: 'LFM Realtime (Default)' },
          { key: 'gemini', label: 'Gemini Live' },
          { key: 'openai', label: 'OpenAI Realtime' },
        ]}
      />
      {tab === 'lfm' ? (
        <>
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-[12px]" style={{ background: alpha(palette.accent, 30), color: palette.accent }}>
              <Mic size={20} />
            </div>
            <p className="t-footnote flex-1" style={{ color: palette.textTertiary }}>
              The orb talks through Liquid AI’s LFM3-Audio Realtime model running locally on this machine via llama.cpp (port 9931). Ultra-low latency conversational voice with native task delegation and complete local privacy.
            </p>
          </div>
          {provider !== 'lfm' && (
            <div className="flex justify-end">
              <Button primary onClick={() => use('lfm')} disabled={saving}>Set as default live voice</Button>
            </div>
          )}
        </>
      ) : tab === 'gemini' ? (
        <>
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-[12px]" style={{ background: alpha(palette.accent, 30), color: palette.accent }}>
              <Mic size={20} />
            </div>
            <p className="t-footnote flex-1" style={{ color: palette.textTertiary }}>
              The orb talks through Google Gemini Live using GEMINI_API_KEY from backend/.env.
            </p>
          </div>
          {provider !== 'gemini' && (
            <div className="flex justify-end">
              <Button primary onClick={() => use('gemini')} disabled={saving}>Use Gemini Live</Button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-[12px]" style={{ background: alpha(palette.accent, 30), color: palette.accent }}>
              <Mic size={20} />
            </div>
            <p className="t-footnote flex-1" style={{ color: palette.textTertiary }}>
              Talk through OpenAI Realtime ({voice.openaiModel || 'gpt-realtime-2.1-mini'}) using OPENAI_API_KEY from backend/.env.
            </p>
          </div>
          {provider !== 'openai' && (
            <div className="flex justify-end">
              <Button primary onClick={() => use('openai')} disabled={saving}>Use OpenAI Realtime</Button>
            </div>
          )}
        </>
      )}
      {error && <Note tone="warn">{error}</Note>}
    </Section>
  );
};
