// The Neural map: the live 3D map of Jarvis and its agents, full-bleed, with glass overlays.
// Click a node for its status; active connections light up as chips.
import { AnimatePresence, motion, useTransform } from 'framer-motion';
import { Waypoints } from 'lucide-react';
import { useMemo } from 'react';
import { useStore } from '../store';
import { NeuralMap } from '../components/NeuralMap';
import { alpha, palette, spring } from '../ui';
import { usePointer } from '../shell/Backdrop';
import { agentMeta } from '../shell/status';

export function NeuralScreen() {
  const agents = useStore((s) => s.agents);
  const activeAgentConnections = useStore((s) => s.activeAgentConnections);
  const voiceState = useStore((s) => s.voiceState);
  const shown = useMemo(
    () => agents.filter((a) => a.id !== 'jarvis' && (activeAgentConnections.includes(a.id) || ['hermes', 'gemini', 'claude', 'agy', 'codex'].includes(a.id))),
    [agents, activeAgentConnections],
  );
  // Overlays drift slightly against the pointer: the map feels deeper than the glass.
  const { x, y } = usePointer();
  const ox = useTransform(x, (v) => v * 8);
  const oy = useTransform(y, (v) => v * 6);

  return (
    <div className="relative h-full overflow-hidden">
      <div className="absolute inset-0">
        <NeuralMap
          agents={shown}
          isSpeaking={voiceState.isSpeaking}
          onNodeClick={(id, status, desc) => useStore.setState({
            agentOutcome: { agentId: id, agentName: id.charAt(0).toUpperCase() + id.slice(1), result: `**Status:** ${status}\n\n${desc}` },
          })}
        />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(70% 60% at 50% 45%, transparent, ${alpha(palette.bg, 200)})` }} />

      <motion.div style={{ x: ox, y: oy }} className="pointer-events-none absolute left-4 top-5 md:left-8">
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle} className="glass shadow-float pointer-events-auto rounded-[24px] px-5 py-4">
          <div className="flex items-center gap-2">
            <Waypoints size={18} style={{ color: palette.accent }} />
            <h1 className="t-title1">Neural map</h1>
          </div>
          <p className="mt-1 t-subhead" style={{ color: palette.textSecondary }}>Jarvis and its agents, live. Click a node for its status.</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {shown.map((a) => {
              const meta = agentMeta(a.id);
              const on = activeAgentConnections.includes(a.id);
              return (
                <motion.span key={a.id} layout transition={spring.snappy} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 t-caption"
                  style={{ background: on ? alpha(meta.color, 40) : palette.surface, borderColor: on ? alpha(meta.color, 140) : palette.stroke, color: on ? meta.color : palette.textSecondary }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: on ? meta.color : palette.muted }} />
                  {a.id === 'gemini' ? 'Antigravity' : a.name.charAt(0) + a.name.slice(1).toLowerCase()}
                </motion.span>
              );
            })}
          </div>
        </motion.div>
      </motion.div>

      <div className="pointer-events-none absolute inset-x-0 bottom-32 flex justify-center px-4">
        <AnimatePresence>
          {voiceState.transcript && (
            <motion.div initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }} transition={spring.gentle}
              className="glass max-w-2xl rounded-[18px] px-5 py-3 text-center t-callout">
              <span className="t-eyebrow mr-2" style={{ color: voiceState.role === 'user' ? palette.warning : palette.accent }}>{voiceState.role === 'user' ? 'You' : 'Jarvis'}</span>
              {voiceState.transcript}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
