import React, { useState, useEffect, useCallback } from 'react';
import { useStore, API_KEY, DEFAULT_AVATAR } from '../store';
import { Settings as SettingsIcon, Plus, Trash2 } from 'lucide-react';
import { Pressable, Sheet, alpha, palette } from '../ui';
import { CreateAvatarModal } from './CreateAvatarModal';

const AVATAR_OPTIONS = [
  'maria', 'ben', 'kate', 'john', 'oliver', 'clara', 'ming', 
  'elena', 'jack', 'may', 'arnold', 'camila', 'caroline', 
  'gordon', 'marcus', 'mozart', 'trevor'
];

/** A settings group (module level: defined inside the component, its inputs would remount on every keystroke). */
const Section = ({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) => (
  <section className="surface flex flex-col gap-3 p-4">
    <div className="flex items-center justify-between gap-2">
      <h3 className="t-eyebrow" style={{ color: palette.textTertiary }}>{title}</h3>
      {aside}
    </div>
    {children}
  </section>
);

export const SettingsOverlay: React.FC = () => {
  const { 
    settingsOpen, setSettingsOpen, 
    hostUrl, apiKey, activeServerUrl, activeServerName, serverError,
    appLanguage, ttsServer, cryptoWallet, newsRssUrl,
    avatarId, updateSettings, installedAgents,
    availableModels, selectedModels, setSelectedModel,
    avatarTrainingJobs 
  } = useStore();

  const [localHost, setLocalHost] = useState(hostUrl);
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localLang, setLocalLang] = useState(appLanguage);
  const [localTts, setLocalTts] = useState(ttsServer);
  const [localWallet, setLocalWallet] = useState(cryptoWallet);
  const [localNews, setLocalNews] = useState(newsRssUrl);
  const [localAvatarId, setLocalAvatarId] = useState(avatarId || DEFAULT_AVATAR);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Only the avatars the connected server has (others would render as a fallback avatar).
  const [avatarOptions, setAvatarOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!settingsOpen || !activeServerUrl) return;
    fetch(`${activeServerUrl}/api/avatar/avatars`, { headers: { 'x-api-key': API_KEY } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: string[] = (d?.avatars || []).map((a: string) => a.toLowerCase());
        if (!list.length) return;
        setAvatarOptions(list);
        setLocalAvatarId((cur) => (list.includes(cur) ? cur : list.includes(DEFAULT_AVATAR) ? DEFAULT_AVATAR : list[0]));
      })
      .catch(() => {});
  }, [settingsOpen, activeServerUrl]);

  useEffect(() => {
    setLocalHost(hostUrl);
    setLocalApiKey(apiKey);
    setLocalLang(appLanguage);
    setLocalTts(ttsServer);
    setLocalWallet(cryptoWallet);
    setLocalNews(newsRssUrl);
    setLocalAvatarId(avatarId || DEFAULT_AVATAR);
  }, [hostUrl, apiKey, appLanguage, ttsServer, cryptoWallet, newsRssUrl, avatarId, settingsOpen]);

  const handleSave = () => {
    updateSettings({
      hostUrl: localHost.trim(),
      apiKey: localApiKey.trim(),
      appLanguage: localLang,
      ttsServer: localTts,
      cryptoWallet: localWallet,
      newsRssUrl: localNews,
      avatarId: localAvatarId,
    });
    setSettingsOpen(false);
  };

  const handleDeleteCustomAvatar = async (targetId: string) => {
    if (!confirm(`Are you sure you want to delete custom avatar "${targetId.toUpperCase()}"?`)) return;
    try {
      if (!activeServerUrl) throw new Error('Not connected to a Jarvis server');
      const res = await fetch(`${activeServerUrl}/api/avatar/${targetId}`, { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to delete avatar');
      }
      setAvatarOptions(prev => prev.filter(a => a !== targetId));
      if (localAvatarId === targetId) {
        setLocalAvatarId(DEFAULT_AVATAR);
      }
    } catch (e: any) {
      alert(e.message || 'Failed to delete avatar');
    }
  };

  const handleCloseCreateModal = useCallback(() => {
    setShowCreateModal(false);
  }, []);

  const handleAvatarCreated = useCallback((newId: string) => {
    setAvatarOptions(prev => prev.includes(newId) ? prev : [newId, ...prev]);
    const job = avatarTrainingJobs?.[newId];
    if (!job || job.status === 'ready') {
      setLocalAvatarId(newId);
    }
  }, [avatarTrainingJobs]);

  const chip = (active: boolean, accent: string = palette.accent) => ({
    className: 'flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 t-subhead capitalize transition-colors',
    style: active
      ? { background: alpha(accent, 40), borderColor: alpha(accent, 140), color: accent }
      : { background: palette.surfaceRaised, borderColor: palette.stroke, color: palette.textSecondary },
  });
  const input = 'w-full rounded-[14px] border border-stroke bg-surface-raised px-4 py-2.5 t-body text-text outline-none transition-colors placeholder:text-text-3 focus:border-accent/70';

  const renderModelSelector = (agent: string, title: string) => {
    const models = availableModels?.[agent] || [];
    if (!models.length) return null;
    return (
      <div key={agent} className="flex flex-col gap-2">
        <span className="t-subhead" style={{ color: palette.textSecondary }}>{title}</span>
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
          {models.map(m => (
            <button key={m} type="button" onClick={() => setSelectedModel(agent, m)} {...chip(selectedModels[agent] === m)}>
              <span className="normal-case">{m}</span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <>
      <Sheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Settings"
        subtitle={activeServerName ? `Connected to ${activeServerName}` : serverError ? 'Not connected' : 'Connecting…'}
        icon={SettingsIcon}
        width={720}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Pressable onClick={() => setSettingsOpen(false)} className="h-10 rounded-full px-5 t-subhead" style={{ background: palette.surfaceRaised, color: palette.textSecondary }}>Cancel</Pressable>
            <Pressable onClick={handleSave} className="h-10 rounded-full px-5 t-subhead" style={{ background: palette.accent, color: palette.textInverse }}>Save &amp; reconnect</Pressable>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Section title="Conversation">
            <div className="flex flex-col gap-2">
              <span className="t-subhead" style={{ color: palette.textSecondary }}>Default language</span>
              <div className="flex flex-wrap gap-1.5">
                {[['en', 'English'], ['pt', 'Português'], ['es', 'Español'], ['fr', 'Français'], ['it', 'Italiano']].map(([lang, name]) => (
                  <button key={lang} type="button" onClick={() => setLocalLang(lang)} {...chip(localLang === lang)}>{name}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="t-subhead" style={{ color: palette.textSecondary }}>Live avatar</span>
                <Pressable onClick={() => setShowCreateModal(true)} className="flex items-center gap-1 rounded-full px-3 py-1 t-subhead" style={{ background: alpha(palette.accent, 36), color: palette.accent }}>
                  <Plus size={14} /> New avatar
                </Pressable>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(avatarOptions.length ? avatarOptions : [localAvatarId]).map(av => {
                  const job = avatarTrainingJobs?.[av];
                  const isGenerating = job && job.status === 'training';
                  const isBuiltin = AVATAR_OPTIONS.includes(av.toLowerCase());
                  const c = chip(localAvatarId === av, isGenerating ? palette.warning : palette.accent);
                  return (
                    <button key={av} type="button" disabled={isGenerating} onClick={() => { if (!isGenerating) setLocalAvatarId(av); }}
                      className={`${c.className} ${isGenerating ? 'opacity-60' : ''}`} style={c.style}>
                      <span>{av}</span>
                      {isGenerating && <span className="t-caption" style={{ color: palette.warning }}>{job.progress}%</span>}
                      {!isBuiltin && !isGenerating && (
                        <span role="button" title={`Delete custom avatar "${av}"`} onClick={(e) => { e.stopPropagation(); handleDeleteCustomAvatar(av); }}
                          className="rounded-full p-0.5 hover:bg-[rgba(239,68,68,0.2)] hover:text-[#EF4444]">
                          <Trash2 size={12} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </Section>

          <Section title="Server" aside={<span className="t-footnote" style={{ color: serverError ? palette.warning : palette.textTertiary }}>{activeServerName || (serverError ? 'Not connected' : 'Connecting…')}</span>}>
            <input type="text" value={localHost} onChange={e => setLocalHost(e.target.value)} placeholder="https://your-domain.com or http://192.168.1.10:4000" className={input} />
            <input type="password" value={localApiKey} onChange={e => setLocalApiKey(e.target.value)} placeholder="The server's API key (API_KEY in backend/.env)" autoComplete="off" className={input} />
            <p className="t-footnote" style={{ color: palette.textTertiary }}>Voice and the avatar both connect to this server.</p>
            {serverError && <p className="t-footnote" style={{ color: palette.warning }}>{serverError}</p>}
          </Section>

          <Section title="Integrations">
            <label className="flex flex-col gap-1.5">
              <span className="t-subhead" style={{ color: palette.textSecondary }}>Local TTS server <span style={{ color: palette.textTertiary }}>· optional</span></span>
              <input type="text" value={localTts} onChange={e => setLocalTts(e.target.value)} placeholder="Kokoro TTS endpoint" className={input} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="t-subhead" style={{ color: palette.textSecondary }}>Crypto wallet address</span>
              <input type="text" value={localWallet} onChange={e => setLocalWallet(e.target.value)} placeholder="0x…" className={input} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="t-subhead" style={{ color: palette.textSecondary }}>News RSS feeds <span style={{ color: palette.textTertiary }}>· comma-separated</span></span>
              <input type="text" value={localNews} onChange={e => setLocalNews(e.target.value)} placeholder="https://…/rss.xml, …" className={input} />
            </label>
          </Section>

          {installedAgents.some(a => (availableModels?.[a.id] || []).length) && (
            <Section title="Agents' default models">
              {installedAgents.map(a => renderModelSelector(a.id, a.id === 'gemini' ? 'Antigravity' : a.name))}
            </Section>
          )}
        </div>
      </Sheet>

      <CreateAvatarModal
        isOpen={showCreateModal}
        onClose={handleCloseCreateModal}
        onAvatarCreated={handleAvatarCreated}
      />
    </>
  );
};
