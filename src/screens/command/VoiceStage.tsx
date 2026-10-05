// The voice stage (mobile VoiceStageCard): the orb or the live avatar in a card that tilts
// with the pointer, washed in the voice state's colour, with the caption and live transcript.
import { AnimatePresence, motion, useMotionTemplate, useReducedMotion, useTransform } from 'framer-motion';
import { Eye, EyeOff, MonitorUp, Orbit, UserRound } from 'lucide-react';
import { useStore } from '../../store';
import { BlobAnimation } from '../../components/BlobAnimation';
import { TalkingAvatar } from '../../components/TalkingAvatar';
import { IconButton, Pressable, SegmentedControl, StatusDot, alpha, palette, spring } from '../../ui';
import { usePointer } from '../../shell/Backdrop';
import { useIsDelegating, useVoiceStatus } from '../../shell/status';

const caption = (s: { connected: boolean; isListening: boolean; isSpeaking: boolean; isDelegating: boolean; avatarMode: boolean }) => {
  if (!s.connected) return 'Offline — reconnecting';
  if (s.isListening) return 'Listening — speak naturally';
  if (s.isSpeaking) return 'Jarvis is speaking · click to interrupt';
  if (s.isDelegating) return 'Working with your agents…';
  return s.avatarMode ? 'Live avatar · press the mic to talk' : 'Click the orb to talk';
};

export function VoiceStage() {
  const voiceState = useStore((s) => s.voiceState);
  const connected = useStore((s) => s.wsConnected);
  const avatarMode = useStore((s) => s.avatarMode);
  const setAvatarMode = useStore((s) => s.setAvatarMode);
  const geminiLiveMode = useStore((s) => s.geminiLiveMode);
  const setGeminiLiveMode = useStore((s) => s.setGeminiLiveMode);
  const cameraActive = useStore((s) => s.cameraActive);
  const toggleCamera = useStore((s) => s.toggleCamera);
  const screenActive = useStore((s) => s.screenActive);
  const toggleScreen = useStore((s) => s.toggleScreen);
  const toggleMic = useStore((s) => s.toggleMic);
  const isDelegating = useIsDelegating();
  const status = useVoiceStatus();
  const reduced = useReducedMotion();
  const transcript = voiceState.transcript?.trim();

  // Parallax: the card tilts a few degrees towards the pointer, its glow follows it.
  const { x, y } = usePointer();
  const rotateY = useTransform(x, (v) => (reduced ? 0 : v * 3.5));
  const rotateX = useTransform(y, (v) => (reduced ? 0 : v * -2.5));
  const glowX = useTransform(x, (v) => `${50 + v * 18}%`);
  const glowY = useTransform(y, (v) => `${42 + v * 12}%`);
  const glow = useMotionTemplate`radial-gradient(55% 60% at ${glowX} ${glowY}, ${alpha(status.color, 44)}, transparent 70%)`;

  return (
    <div style={{ perspective: 1600 }}>
      <motion.section
        aria-label="Voice"
        style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}
        className="surface shadow-card relative overflow-hidden rounded-[28px]"
      >
        <motion.div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: glow }} />
        <motion.div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-2/3"
          animate={{ background: `linear-gradient(${alpha(status.color, 26)}, transparent)` }} transition={{ duration: 0.6 }} />

        <div className="relative z-20 flex items-center justify-between gap-3 px-4 pt-4">
          <SegmentedControl
            label="Voice view"
            compact
            className="w-[210px]"
            segments={[{ key: 'orb', label: 'Orb', icon: Orbit }, { key: 'avatar', label: 'Avatar', icon: UserRound }]}
            value={avatarMode ? 'avatar' : 'orb'}
            onChange={(k) => setAvatarMode(k === 'avatar')}
          />
          <AnimatePresence>
            {(geminiLiveMode || avatarMode) && (
              <motion.div className="flex gap-2" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={spring.bouncy}>
                <IconButton icon={cameraActive ? Eye : EyeOff} size={38} active={cameraActive} activeColor={palette.listening}
                  label={cameraActive ? 'Turn camera vision off' : 'Let Jarvis see through the camera'} onClick={toggleCamera} />
                <IconButton icon={MonitorUp} size={38} active={screenActive}
                  label={screenActive ? 'Stop sharing the screen' : 'Share the screen with Jarvis'} onClick={toggleScreen} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <motion.div layout transition={spring.gentle} className="relative z-10"
          style={{ height: avatarMode ? 'min(64vh, 720px)' : 'min(46vh, 520px)', transform: 'translateZ(30px)' }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={avatarMode ? 'avatar' : 'orb'} className="absolute inset-0"
              initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.02 }} transition={{ duration: 0.32, ease: [0.2, 0, 0, 1] }}>
              {avatarMode ? <TalkingAvatar onClick={toggleMic} /> : <BlobAnimation onClick={toggleMic} />}
            </motion.div>
          </AnimatePresence>
        </motion.div>

        <div className="relative z-20 flex flex-col gap-3 px-5 pb-5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={status.label + String(avatarMode)} className="flex items-center justify-center gap-2"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
              <StatusDot color={status.color} pulse={status.pulse} size={7} />
              <span className="t-subhead" style={{ color: palette.textSecondary }}>
                {caption({ connected, isListening: voiceState.isListening, isSpeaking: voiceState.isSpeaking, isDelegating, avatarMode })}
              </span>
            </motion.div>
          </AnimatePresence>

          <AnimatePresence>
            {!geminiLiveMode && !avatarMode && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={spring.gentle}>
                <Pressable onClick={() => setGeminiLiveMode(true)} pressedScale={0.98}
                  className="flex w-full items-center gap-3 rounded-[14px] border px-4 py-2.5 text-left"
                  style={{ background: alpha(palette.warning, 38), borderColor: alpha(palette.warning, 85) }}>
                  <span className="flex-1 t-footnote" style={{ color: palette.warning }}>Gemini Live is off — voice goes straight to your agents.</span>
                  <span className="t-subhead" style={{ color: palette.accent }}>Turn on</span>
                </Pressable>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {transcript && (
              <motion.div layout initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10 }} transition={spring.gentle}
                className="rounded-[14px] border px-4 py-2.5"
                style={voiceState.role === 'user'
                  ? { background: alpha(palette.warning, 38), borderColor: alpha(palette.warning, 64) }
                  : { background: alpha(palette.accent, 36), borderColor: alpha(palette.accent, 64) }}>
                <div className="t-eyebrow" style={{ color: voiceState.role === 'user' ? palette.warning : palette.accent }}>{voiceState.role === 'user' ? 'You' : 'Jarvis'}</div>
                <div className="t-callout line-clamp-3">{transcript}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.section>
    </div>
  );
}
