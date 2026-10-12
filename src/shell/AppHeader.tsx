// The app header (mobile AppHeader): wordmark + live status, screen switch, the agent/model
// picker, the Gemini Live switch, language and settings — one glass bar.
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, History, Orbit, Settings, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { LanguageSelector } from '../components/LanguageSelector';
import { IconButton, Pressable, SegmentedControl, StatusDot, Switch, alpha, palette, spring } from '../ui';
import { providerFor, providersFor, useVoiceStatus } from './status';

/** Opens the results history; a small count once there are entries. */
function HistoryButton() {
  const count = useStore((s) => s.resultHistory.length);
  return (
    <div className="relative shrink-0">
      <IconButton icon={History} label="Results history" size={44} className="max-sm:!h-10 max-sm:!w-10" onClick={() => useStore.getState().setHistoryOpen(true)} />
      <AnimatePresence>
        {count > 0 && (
          <motion.span
            key="badge"
            aria-hidden
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={spring.bouncy}
            className="pointer-events-none absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-bold leading-none tabular"
            style={{ background: palette.accent, color: palette.textInverse, boxShadow: `0 0 0 2px ${palette.surface}` }}
          >
            {count > 99 ? '99+' : count}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModelPicker() {
  const installedAgents = useStore((s) => s.installedAgents);
  const aiModel = useStore((s) => s.aiModel);
  const setAiModel = useStore((s) => s.setAiModel);
  const selectedModels = useStore((s) => s.selectedModels);
  const setSelectedModel = useStore((s) => s.setSelectedModel);
  const availableModels = useStore((s) => s.availableModels);
  const providers = useMemo(() => providersFor(installedAgents), [installedAgents]);
  const provider = providerFor(providers, aiModel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const models = availableModels?.[aiModel] || [];
  const Icon = provider.icon;

  return (
    <div ref={ref} className="relative">
      <Pressable
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose agent and model"
        className="flex h-11 items-center gap-2.5 rounded-full border pl-1.5 pr-3 transition-colors hover:border-[rgba(148,210,255,0.3)]"
        style={{ background: palette.surface, borderColor: palette.stroke }}
      >
        <span className="grid h-8 w-8 place-items-center rounded-full border" style={{ background: alpha(provider.color, 42), borderColor: alpha(provider.color, 112), color: provider.color }}>
          <Icon size={14} />
        </span>
        <span className="min-w-0 text-left leading-tight">
          <span className="block t-subhead">{provider.label}</span>
          <span className="block max-w-[150px] truncate t-caption" style={{ color: palette.textTertiary }}>{selectedModels[aiModel] || 'Default model'}</span>
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={spring.snappy} style={{ color: palette.textTertiary }}>
          <ChevronDown size={16} />
        </motion.span>
      </Pressable>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={spring.snappy}
            className="popover shadow-float absolute right-0 top-[calc(100%+10px)] z-[60] w-[320px] origin-top-right rounded-[20px] p-2"
          >
            <div className="px-2 pt-1 pb-2 t-eyebrow" style={{ color: palette.textTertiary }}>Agent</div>
            {providers.length === 0 && <div className="px-2 pb-2 t-footnote" style={{ color: palette.textTertiary }}>No agents reported by this server yet.</div>}
            {providers.map((p) => {
              const PIcon = p.icon;
              const active = p.key === aiModel;
              return (
                <button key={p.key} role="menuitemradio" aria-checked={active} onClick={() => setAiModel(p.key)}
                  className="flex w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left transition-colors hover:bg-[rgba(148,210,255,0.06)]"
                  style={active ? { background: alpha(p.color, 26) } : undefined}>
                  <span className="grid h-8 w-8 place-items-center rounded-[10px]" style={{ background: alpha(p.color, 36), color: p.color }}><PIcon size={15} /></span>
                  <span className="flex-1 t-callout">{p.label}</span>
                  {active && <Check size={16} style={{ color: p.color }} />}
                </button>
              );
            })}
            {models.length > 0 && (
              <>
                <div className="mx-2 my-2 h-px" style={{ background: palette.stroke }} />
                <div className="px-2 pb-2 t-eyebrow" style={{ color: palette.textTertiary }}>Model</div>
                <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto px-2 pb-2 scrollbar-thin">
                  {models.map((m) => {
                    const active = selectedModels[aiModel] === m;
                    return (
                      <button key={m} onClick={() => setSelectedModel(aiModel, m)}
                        className="rounded-full border px-2.5 py-1 t-footnote transition-colors"
                        style={{ background: active ? alpha(provider.color, 40) : palette.surfaceRaised, borderColor: active ? alpha(provider.color, 130) : palette.stroke, color: active ? provider.color : palette.textSecondary }}>
                        {m}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function AppHeader() {
  const screen = useStore((s) => s.screen);
  const setScreen = useStore((s) => s.setScreen);
  const geminiLiveMode = useStore((s) => s.geminiLiveMode);
  const setGeminiLiveMode = useStore((s) => s.setGeminiLiveMode);
  const language = useStore((s) => s.language);
  const setLanguage = useStore((s) => s.setLanguage);
  const isTtsLoading = useStore((s) => s.isTtsLoading);
  const activeServerName = useStore((s) => s.activeServerName);
  const status = useVoiceStatus();

  return (
    <header className="relative z-30 px-4 pt-4 md:px-6">
      <div className="glass shadow-float flex flex-wrap items-center gap-3 rounded-[24px] px-4 py-2.5 lg:flex-nowrap">
        <div className="mr-auto flex min-w-0 items-center gap-4">
          <div className="min-w-0">
            <div className="t-title2" style={{ color: palette.text, letterSpacing: '0.32em', fontWeight: 650 }}>JARVIS</div>
            <motion.div layout transition={spring.snappy} className="flex items-center gap-1.5">
              <StatusDot color={status.color} pulse={status.pulse} size={7} />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={status.label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}
                  className="t-footnote" style={{ color: status.color }}>
                  {status.label}
                </motion.span>
              </AnimatePresence>
              {activeServerName && <span className="hidden truncate t-footnote lg:inline" style={{ color: palette.textTertiary }}>· {activeServerName}</span>}
            </motion.div>
          </div>
        </div>

        <SegmentedControl
          label="Screen"
          className="order-last w-full lg:order-none lg:w-[300px]"
          segments={[{ key: 'command', label: 'Command', icon: Orbit }, { key: 'orchestrator', label: 'Neural map', icon: Waypoints }]}
          value={screen}
          onChange={setScreen}
        />

        <div className="flex items-center gap-2 lg:ml-auto">
          <ModelPicker />
          <Pressable
            onClick={() => setGeminiLiveMode(!geminiLiveMode)}
            role="switch"
            aria-checked={geminiLiveMode}
            aria-label="Gemini Live conversation"
            title={geminiLiveMode ? 'Gemini Live is on — voice goes to the live conversation' : 'Gemini Live is off — voice goes straight to your agents'}
            className="hidden h-11 items-center gap-3 whitespace-nowrap rounded-full border pl-4 pr-2 sm:flex"
            style={{ background: palette.surface, borderColor: geminiLiveMode ? alpha(palette.accent, 85) : palette.stroke }}
          >
            <span className="text-left leading-tight">
              <span className="block t-caption" style={{ color: palette.textTertiary }}>Gemini Live</span>
              <span className="block t-subhead" style={{ color: geminiLiveMode ? palette.accent : palette.textSecondary }}>{geminiLiveMode ? 'On' : 'Off'}</span>
            </span>
            <Switch value={geminiLiveMode} />
          </Pressable>
          <div className="relative">
            <LanguageSelector value={language} onChange={setLanguage} disabled={isTtsLoading} />
          </div>
          <HistoryButton />
          <IconButton icon={Settings} label="Settings" size={44} className="shrink-0 max-sm:!h-10 max-sm:!w-10" onClick={() => useStore.getState().setSettingsOpen(true)} />
        </div>
      </div>
    </header>
  );
}
