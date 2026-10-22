// Settings → Hands-free: start talking to Jarvis by saying "Hey Jarvis" or clapping twice. Per
// device (kept in this browser / app, never on the server); the switches apply at once.
import React from 'react';
import { AudioLines, Hand, Lock, RotateCcw, Sparkles, type LucideIcon } from 'lucide-react';
import { useStore } from '../store';
import { Meter, Pressable, SegmentedControl, StatusDot, Switch, alpha, palette } from '../ui';
import { Section } from './SettingsSection';
import { standbyStatusText, type ClapSensitivity } from '../server/wakeStandby';
import { retryWake, testWake, useWakeStatus } from '../runtime/wake/standby';

const Row = ({ icon: Icon, title, detail, on, onToggle }: { icon: LucideIcon; title: string; detail: string; on: boolean; onToggle: () => void }) => (
  <Pressable onClick={onToggle} pressedScale={0.99} role="switch" aria-checked={on} className="flex items-center gap-3 text-left">
    <div className="grid size-10 shrink-0 place-items-center rounded-[12px]" style={{ background: alpha(palette.accent, on ? 40 : 18), color: on ? palette.accent : palette.textTertiary }}>
      <Icon size={20} />
    </div>
    <div className="min-w-0 flex-1">
      <p className="t-body">{title}</p>
      <p className="t-footnote" style={{ color: palette.textTertiary }}>{detail}</p>
    </div>
    <Switch value={on} />
  </Pressable>
);

export const WakeSettings: React.FC = () => {
  const heyJarvis = useStore((s) => s.wakeHeyJarvis);
  const clap = useStore((s) => s.wakeClap);
  const sensitivity = useStore((s) => s.clapSensitivity);
  const setWake = useStore((s) => s.setWakeSettings);
  const { phase, model, heard, testing } = useWakeStatus();
  const prefs = { heyJarvis, clap };
  const anyOn = heyJarvis || clap;
  const desktop = typeof window !== 'undefined' && !!(window as unknown as { jarvisDesktop?: unknown }).jarvisDesktop;

  const status = testing && !heard && phase.kind === 'running'
    ? `Testing — ${heyJarvis && clap ? 'say “Hey Jarvis” or clap twice' : heyJarvis ? 'say “Hey Jarvis”' : 'clap twice'}…`
    : standbyStatusText(prefs, phase, model, heard);
  const problem = phase.kind === 'mic-blocked' || phase.kind === 'mic-error' || (heyJarvis && model.kind === 'error');
  const live = phase.kind === 'running';
  const color = heard ? palette.success : problem ? palette.warning : live ? palette.accent : palette.textTertiary;

  return (
    <Section title="Hands-free" aside={<span className="t-footnote" style={{ color: anyOn ? palette.accent : palette.textTertiary }}>{anyOn ? 'On' : 'Off'}</span>}>
      <Row icon={AudioLines} title="“Hey Jarvis”" detail="Say it to start talking — or say it with your request: “Hey Jarvis, what’s the weather?”"
        on={heyJarvis} onToggle={() => setWake({ wakeHeyJarvis: !heyJarvis })} />
      <Row icon={Hand} title="Double clap" detail="Clap twice to start talking."
        on={clap} onToggle={() => setWake({ wakeClap: !clap })} />
      {clap && (
        <div className="flex flex-col gap-2">
          <span className="t-subhead" style={{ color: palette.textSecondary }}>Clap sensitivity <span style={{ color: palette.textTertiary }}>· Less ignores more noises, More hears softer claps</span></span>
          <SegmentedControl<ClapSensitivity>
            label="Clap sensitivity"
            value={sensitivity}
            onChange={(v) => setWake({ clapSensitivity: v })}
            segments={[{ key: 'less', label: 'Less' }, { key: 'normal', label: 'Normal' }, { key: 'more', label: 'More' }]}
          />
        </div>
      )}
      {anyOn && (
        <div className="flex flex-col gap-2 rounded-[14px] border px-4 py-3" style={{ background: palette.surfaceRaised, borderColor: alpha(color, 60) }} role="status" aria-live="polite">
          <div className="flex items-center gap-2.5">
            <StatusDot color={color} pulse={live || !!heard} size={8} />
            <span className="flex-1 t-subhead" style={{ color: heard ? palette.success : problem ? palette.warning : palette.textSecondary }}>{status}</span>
            {problem ? (
              <Pressable onClick={retryWake} className="flex h-8 items-center gap-1.5 rounded-full px-3 t-footnote" style={{ background: palette.surfaceHigh, color: palette.text }}>
                <RotateCcw size={13} /> Try again
              </Pressable>
            ) : (
              <Pressable onClick={testWake} disabled={!live} className="flex h-8 items-center gap-1.5 rounded-full px-3 t-footnote disabled:opacity-40"
                style={{ background: testing ? alpha(palette.accent, 40) : palette.surfaceHigh, color: testing ? palette.accent : palette.text }}>
                <Sparkles size={13} /> Test
              </Pressable>
            )}
          </div>
          {heyJarvis && model.kind === 'downloading' && <Meter value={model.percent} />}
        </div>
      )}
      <p className="flex items-start gap-1.5 t-footnote" style={{ color: palette.textTertiary }}>
        <Lock size={13} className="mt-[2px] shrink-0" />
        <span>
          Sound is analysed on this device and never sent anywhere until Jarvis hears its name or two claps.
          {heyJarvis && ' The first time, Jarvis downloads a small speech model (about 50 MB) from Hugging Face; it then stays on this device.'}
          {anyOn && (desktop
            ? ' Works while the Jarvis window is open — also behind other windows or minimized.'
            : ' Works while Jarvis is open in this browser.')}
          {' '}It pauses while Jarvis is listening or talking, and during a live avatar call.
        </span>
      </p>
    </Section>
  );
};
