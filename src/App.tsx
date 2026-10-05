import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RefreshCw, Settings, WifiOff } from 'lucide-react';
import { useStore } from './store';
import { SettingsOverlay } from './components/SettingsOverlay';
import { Backdrop } from './shell/Backdrop';
import { AppHeader } from './shell/AppHeader';
import { Dock } from './shell/Dock';
import { ResultSheet } from './shell/ResultSheet';
import { CommandScreen } from './screens/CommandScreen';
import { NeuralScreen } from './screens/NeuralScreen';
import { Pressable, alpha, palette, spring } from './ui';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="surface max-w-2xl p-6" style={{ borderColor: alpha(palette.listening, 80) }}>
          <h2 className="t-title2" style={{ color: palette.listening }}>Something went wrong on this screen</h2>
          <pre className="mt-3 max-h-64 overflow-auto rounded-[12px] p-3 t-mono" style={{ background: 'rgba(0,0,0,0.35)', color: palette.textSecondary }}>
            {this.state.error.message}{'\n\n'}{this.state.error.stack}
          </pre>
          <Pressable onClick={() => this.setState({ error: null })} className="mt-4 rounded-full px-5 py-2 t-subhead" style={{ background: palette.accent, color: palette.textInverse }}>
            Try again
          </Pressable>
        </div>
      </div>
    );
  }
}

/** Keeps a screen mounted once visited (the avatar's WebRTC session, the 3D map) and cross-fades. */
function ScreenLayer({ active, side, children }: { active: boolean; side: -1 | 1; children: React.ReactNode }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true); // first visit mounts it; it stays mounted after
  if (!visited && !active) return null;
  return (
    <motion.div
      className="absolute inset-0"
      style={{ zIndex: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }}
      initial={false}
      animate={{ opacity: active ? 1 : 0, x: active ? 0 : 32 * side, scale: active ? 1 : 0.98 }}
      transition={{ duration: 0.34, ease: [0.2, 0, 0, 1] }}
      aria-hidden={!active}
    >
      {children}
    </motion.div>
  );
}

/** Not connected: say why, and offer the fix. */
function ConnectionBanner() {
  const wsConnected = useStore((s) => s.wsConnected);
  const serverError = useStore((s) => s.serverError);
  const [grace, setGrace] = useState(true);
  useEffect(() => { const t = setTimeout(() => setGrace(false), 2500); return () => clearTimeout(t); }, []);
  const show = !wsConnected && !grace;
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="relative z-20 px-4 pt-3 md:px-6" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={spring.gentle}>
          <div className="mx-auto flex max-w-[1560px] items-center gap-3 rounded-[16px] border px-4 py-2.5"
            style={{ background: alpha(palette.warning, 30), borderColor: alpha(palette.warning, 90) }}>
            <WifiOff size={17} style={{ color: palette.warning }} />
            <span className="flex-1 t-subhead" style={{ color: palette.warning }}>{serverError || 'Reconnecting to Jarvis…'}</span>
            <Pressable onClick={() => useStore.getState().setSettingsOpen(true)} className="flex items-center gap-1.5 t-subhead" style={{ color: palette.text }}>
              <Settings size={14} /> Server settings
            </Pressable>
            <Pressable onClick={() => window.location.reload()} className="ml-2 flex items-center gap-1.5 t-subhead" style={{ color: palette.textSecondary }}>
              <RefreshCw size={14} /> Retry
            </Pressable>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function App() {
  const screen = useStore((s) => s.screen);
  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden">
      <Backdrop />
      <AppHeader />
      <ConnectionBanner />
      <main className="relative z-10 min-h-0 flex-1">
        <ErrorBoundary>
          <ScreenLayer active={screen === 'command'} side={-1}><CommandScreen /></ScreenLayer>
          <ScreenLayer active={screen === 'orchestrator'} side={1}><NeuralScreen /></ScreenLayer>
        </ErrorBoundary>
      </main>
      <Dock />
      <ResultSheet />
      <SettingsOverlay />
    </div>
  );
}

export default App;
