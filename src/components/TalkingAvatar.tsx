import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore, BACKEND_HTTP, API_KEY, DEFAULT_AVATAR } from '../store';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Mic, MicOff, RefreshCw, User, Image, Sparkles,
  Check, ChevronDown, Plus, Loader2, Trash2
} from 'lucide-react';
import { CreateAvatarModal } from './CreateAvatarModal';
import { detectSpecialContent } from './overlayCards/detectSpecialContent';

interface TalkingAvatarProps {
  onClick?: () => void;
}

const DEFAULT_AVATARS = [
  'maria', 'kate', 'clara', 'ben', 'john', 'oliver', 'ming', 
  'elena', 'jack', 'may', 'arnold', 'camila', 'caroline', 
  'gordon', 'marcus', 'mozart', 'trevor'
];

const DEFAULT_BACKGROUNDS = [
  'plain_white', 'study_desk', 'bright_loft', 'minimal_office', 
  'aloe_window', 'beige_sofa', 'framed_art', 'jungle_window', 
  'lounge_chairs', 'sunlit_bedroom'
];

const GEMINI_VOICES = ['Kore', 'Aoede', 'Puck', 'Charon', 'Fenrir'];

const AVATAR_VOICES: Record<string, { voice: string; gender: 'female' | 'male' }> = {
  maria: { voice: 'Kore', gender: 'female' },
  kate: { voice: 'Aoede', gender: 'female' },
  clara: { voice: 'Kore', gender: 'female' },
  elena: { voice: 'Aoede', gender: 'female' },
  may: { voice: 'Aoede', gender: 'female' },
  camila: { voice: 'Kore', gender: 'female' },
  caroline: { voice: 'Kore', gender: 'female' },
  ben: { voice: 'Puck', gender: 'male' },
  john: { voice: 'Charon', gender: 'male' },
  oliver: { voice: 'Puck', gender: 'male' },
  ming: { voice: 'Puck', gender: 'male' },
  jack: { voice: 'Fenrir', gender: 'male' },
  arnold: { voice: 'Charon', gender: 'male' },
  gordon: { voice: 'Charon', gender: 'male' },
  marcus: { voice: 'Charon', gender: 'male' },
  mozart: { voice: 'Puck', gender: 'male' },
  trevor: { voice: 'Fenrir', gender: 'male' },
};

export const getAvatarVoice = (avatarId: string): string => {
  const id = (avatarId || '').toLowerCase().trim();
  if (AVATAR_VOICES[id]) return AVATAR_VOICES[id].voice;
  const maleNames = ['ben', 'john', 'oliver', 'ming', 'jack', 'arnold', 'gordon', 'marcus', 'mozart', 'trevor', 'adam', 'david', 'james', 'michael', 'sam'];
  return maleNames.some(m => id.includes(m)) ? 'Puck' : 'Kore';
};

export const getAvatarGender = (avatarId: string): 'female' | 'male' => {
  const id = (avatarId || '').toLowerCase().trim();
  if (AVATAR_VOICES[id]) return AVATAR_VOICES[id].gender;
  const maleNames = ['ben', 'john', 'oliver', 'ming', 'jack', 'arnold', 'gordon', 'marcus', 'mozart', 'trevor'];
  return maleNames.some(m => id.includes(m)) ? 'male' : 'female';
};

const PROMPT_PRESETS = [
  {
    name: 'Jarvis Core (Full Autonomous)',
    prompt: 'You are Jarvis, a concise, friendly and intelligent AI orchestrator. When asked to do any computer, coding, browsing, terminal or file task, ALWAYS delegate to AGY (Antigravity), Claude, or Hermes using your tools.'
  },
  {
    name: 'Tech Architect',
    prompt: 'You are a Senior Systems Architect. Provide sharp technical insights and delegate implementation tasks to Antigravity (AGY) and Claude.'
  },
  {
    name: 'Executive Analyst',
    prompt: 'You are a crisp executive advisor. Deliver direct strategic summaries and delegate data gathering tasks to Antigravity.'
  },
  {
    name: 'Friendly Companion',
    prompt: 'You are a warm, witty, and engaging conversational companion who can also execute local tasks via AGY and Hermes when requested.'
  }
];

function createSilentAudioTrack(): MediaStreamTrack {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  return dest.stream.getAudioTracks()[0];
}

export const TalkingAvatar: React.FC<TalkingAvatarProps> = ({ onClick }) => {
  const { 
    avatarId, setAvatarId, 
    avatarBackgroundId, setAvatarBackgroundId,
    avatarPrompt, setAvatarPrompt,
    avatarVoice, setAvatarVoice,
    activeServerUrl,
    voiceState, setVoiceState,
    setGeminiLiveMode, setAvatarMode,
    setOnAvatarAudio,
    avatarTrainingJobs, setAvatarTrainingJob
  } = useStore();

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const senderRef = useRef<RTCRtpSender | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number>(0);

  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Only the avatars the connected server has (others would render as a fallback avatar).
  const [avatarsList, setAvatarsList] = useState<string[]>(() => [useStore.getState().avatarId || DEFAULT_AVATAR]);
  const [backgroundsList, setBackgroundsList] = useState<string[]>(DEFAULT_BACKGROUNDS);
  const [isMuted, setIsMuted] = useState(false);
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [showCreateAvatarModal, setShowCreateAvatarModal] = useState(false);
  const [showBgMenu, setShowBgMenu] = useState(false);
  const [customPrompt, setCustomPrompt] = useState(avatarPrompt || PROMPT_PRESETS[0].prompt);
  const [isSpeakingLive, setIsSpeakingLive] = useState(false);
  const activeTrainingJobs = Object.values(avatarTrainingJobs || {}).filter(j => j.status === 'training');

  // Handle incoming TTS audio from non-live agent responses
  useEffect(() => {
    setOnAvatarAudio((data: ArrayBuffer, isPcm: boolean, _format: string) => {
      try {
        // If WebRTC live stream is active, WebRTC audio element already plays the stream
        if (status === 'live') {
          return;
        }

        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') ctx.resume();

        setIsSpeakingLive(true);
        setVoiceState({ isSpeaking: true });

        if (isPcm) {
          const int16Array = new Int16Array(data);
          const float32Array = new Float32Array(int16Array.length);
          for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
          }
          const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
          audioBuffer.copyToChannel(float32Array, 0);

          const src = ctx.createBufferSource();
          src.buffer = audioBuffer;
          src.connect(ctx.destination);
          src.onended = () => {
            setIsSpeakingLive(false);
            setVoiceState({ isSpeaking: false });
          };
          src.start();
        } else {
          ctx.decodeAudioData(data.slice(0), (buffer) => {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(ctx.destination);
            src.onended = () => {
              setIsSpeakingLive(false);
              setVoiceState({ isSpeaking: false });
            };
            src.start();
          });
        }
      } catch (err) {
        console.error('[TalkingAvatar] Non-live audio play error:', err);
      }
    });

    return () => {
      setOnAvatarAudio(null);
    };
  }, [setOnAvatarAudio, setVoiceState]);

  // Whenever an assistant transcript with special domain content arrives during Live Avatar,
  // ensure the agentOutcome overlay is triggered immediately if not already open
  useEffect(() => {
    if (voiceState.transcript && voiceState.role === 'assistant') {
      const special = detectSpecialContent(voiceState.transcript, 'JARVIS');
      const has3DMedia = /\.(glb|gltf|obj|stl|fbx)(\?|$|\s|\))/i.test(voiceState.transcript) || voiceState.transcript.includes('/api/local-image');
      if ((special || has3DMedia) && !useStore.getState().agentOutcome) {
        useStore.setState({
          agentOutcome: {
            agentId: 'live-avatar',
            agentName: 'JARVIS // LIVE AVATAR',
            result: voiceState.transcript,
          }
        });
      }
    }
  }, [voiceState.transcript, voiceState.role]);

  // Dynamically resolve backend/streamer candidate bases
  // The avatar runs on the server the voice is connected to — never another one.
  const getCandidateBases = useCallback(
    () => [(activeServerUrl || BACKEND_HTTP).replace(/\/+$/, '')].filter(Boolean),
    [activeServerUrl],
  );

  // Fetch available avatars and backgrounds
  useEffect(() => {
    const fetchAvatars = async () => {
      const bases = getCandidateBases();
      for (const base of bases) {
        for (const path of ['/api/avatar/avatars', '/avatars']) {
          try {
            const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
              const data = await res.json();
              if (data.avatars && data.avatars.length > 0) setAvatarsList(data.avatars);
              if (data.backgrounds && data.backgrounds.length > 0) setBackgroundsList(data.backgrounds);
              if (Array.isArray(data.training)) {
                data.training.forEach((job: any) => {
                  setAvatarTrainingJob(job);
                });
              }
              return;
            }
          } catch (e) {}
        }
      }
    };
    fetchAvatars();
  }, [getCandidateBases]);

  const connectIdRef = useRef(0);

  // Teardown WebRTC session cleanly
  const teardown = useCallback(() => {
    connectIdRef.current++;
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (pcRef.current) {
      try { pcRef.current.close(); } catch (e) {}
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    senderRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setAvatarMode(false);
  }, [setAvatarMode]);

  // Connect WebRTC Session to AVTR-1
  const startSession = useCallback(async () => {
    teardown();
    const currentConnectId = ++connectIdRef.current;
    setStatus('connecting');
    setErrorMessage(null);
    setAvatarMode(true);
    setGeminiLiveMode(true);

    try {
      const bases = getCandidateBases();
      // Only the server we're connected to (and authorized on): never guess another one.
      if (!bases[0]) throw new Error(useStore.getState().serverError || 'Not connected to a Jarvis server — set it in Settings → Server.');
      let workingBase = bases[0];
      let offerPath = '/api/avatar/offer';

      // 1. Fetch ICE configuration
      let iceServers: RTCIceServer[] = [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
      ];

      for (const base of bases) {
        for (const p of ['/api/avatar/ice-servers', '/ice-servers']) {
          try {
            const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
              const data = await res.json();
              if (data.iceServers && data.iceServers.length > 0) {
                iceServers = data.iceServers;
                workingBase = base;
                offerPath = p.startsWith('/api') ? '/api/avatar/offer' : '/offer';
                break;
              }
            }
          } catch (e) {}
        }
      }

      if (currentConnectId !== connectIdRef.current) return;

      // 2. Create WebRTC Peer Connection
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });
      pcRef.current = pc;

      pc.ontrack = (event) => {
        if (currentConnectId !== connectIdRef.current) return;
        
        // Zero-latency jitter buffer target on receiver: render frames instantly as they arrive
        const receiver = pc.getReceivers().find(r => r.track === event.track || r.track?.kind === event.track.kind);
        if (receiver) {
          if ('playoutDelayHint' in receiver) (receiver as any).playoutDelayHint = 0;
          if ('jitterBufferTarget' in receiver) (receiver as any).jitterBufferTarget = 0;
        }

        if (event.track.kind === 'video') {
          if (videoRef.current) {
            videoRef.current.srcObject = event.streams[0] || new MediaStream([event.track]);
            videoRef.current.playsInline = true;
            (videoRef.current as any).webkitPlaysInline = true;
            videoRef.current.muted = true;
            videoRef.current.play().catch(() => {});
          }
        } else if (event.track.kind === 'audio') {
          if (audioRef.current) {
            audioRef.current.srcObject = event.streams[0] || new MediaStream([event.track]);
            audioRef.current.muted = false;
            audioRef.current.volume = 1.0;
            audioRef.current.play().catch((e) => console.warn('[LiveAvatar] audio play note:', e));
          }
        }
      };

      pc.onconnectionstatechange = () => {
        if (currentConnectId !== connectIdRef.current) return;
        const s = pc.connectionState;
        if (s === 'connected') {
          setStatus('live');
          setErrorMessage(null);
        } else if (s === 'failed' || s === 'disconnected') {
          setStatus('error');
          setErrorMessage(`Live Avatar connection ${s}`);
        }
      };

      // 3. Audio Track Handling
      let audioTrack: MediaStreamTrack;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 24000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false
        });
        localStreamRef.current = stream;
        audioTrack = stream.getAudioTracks()[0];
      } catch (err: any) {
        console.warn('[LiveAvatar] Mic access note:', err.message);
        audioTrack = createSilentAudioTrack();
      }

      if (currentConnectId !== connectIdRef.current) return;
      if (localStreamRef.current) {
        senderRef.current = pc.addTrack(audioTrack, localStreamRef.current);
      } else {
        senderRef.current = pc.addTrack(audioTrack);
      }

      const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });

      // Hardware decode preference (H.264 baseline/main) on macOS / iOS / Windows
      if ('setCodecPreferences' in videoTransceiver && typeof RTCRtpReceiver.getCapabilities === 'function') {
        try {
          const capabilities = RTCRtpReceiver.getCapabilities('video');
          if (capabilities && capabilities.codecs) {
            const h264 = capabilities.codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
            const others = capabilities.codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264');
            if (h264.length > 0) {
              videoTransceiver.setCodecPreferences([...h264, ...others]);
            }
          }
        } catch (e) {}
      }

      // 4. Create and gather offer
      const offer = await pc.createOffer();
      
      // Optimize SDP for high-bitrate, fluid low-latency video streaming
      let sdp = offer.sdp || '';
      if (sdp.includes('m=video')) {
        // Enforce 4.5Mbps video bandwidth allocations
        sdp = sdp.replace(/(m=video[^\r\n]*\r\n)/, '$1b=AS:4500\r\nb=TIAS:4500000\r\n');
        // Give Google Congestion Control (GCC) a high starting bitrate (3.5Mbps) instead of 300kbps
        sdp = sdp.replace(
          /(a=fmtp:\d+[^\r\n]*)/g,
          '$1;x-google-min-bitrate=2500;x-google-start-bitrate=3500;x-google-max-bitrate=6000'
        );
      }
      await pc.setLocalDescription(new RTCSessionDescription({ type: offer.type, sdp }));

      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          const checkGathering = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', checkGathering);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', checkGathering);
          setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', checkGathering);
            resolve();
          }, 3000);
        }
      });

      if (currentConnectId !== connectIdRef.current) return;

      const finalLocalDesc = pc.localDescription;
      if (!finalLocalDesc) throw new Error('Local SDP offer description is missing');

      // 5. Post Offer to Streamer
      const engineVoice = avatarVoice || getAvatarVoice(avatarId || DEFAULT_AVATAR);
      const currentJarvisBackend = activeServerUrl || BACKEND_HTTP;
      const engineConfig = {
        type: 'gemini',
        api_key: 'SERVER_MANAGED',
        model: 'models/gemini-2.5-flash-native-audio-latest',
        voice: engineVoice,
        prompt: customPrompt || avatarPrompt || PROMPT_PRESETS[0].prompt,
        avatar_id: avatarId || DEFAULT_AVATAR,
        enable_voice_conversion: true,
        jarvis_backend_url: currentJarvisBackend,
      };

      const payload = {
        engine: engineConfig,
        sdp: finalLocalDesc.sdp,
        type: finalLocalDesc.type,
        avatar_id: avatarId || DEFAULT_AVATAR,
        background_id: avatarBackgroundId || 'bright_loft',
      };

      let response = await fetch(`${workingBase}${offerPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        for (const base of bases) {
          if (base === workingBase) continue;
          try {
            response = await fetch(`${base}${offerPath}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
              body: JSON.stringify(payload)
            });
            if (response.ok) break;
          } catch (e) {}
        }
      }

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 401) throw new Error('This server rejected the API key — check Settings → Server.');
        if (response.status === 502) throw new Error(`The live avatar isn't running on this server: ${errText}`);
        throw new Error(`Streamer rejected offer (HTTP ${response.status}): ${errText}`);
      }

      const answer = await response.json();
      if (currentConnectId !== connectIdRef.current || !pcRef.current || (pc.signalingState as string) === 'closed') {
        return;
      }
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

    } catch (err: any) {
      if (currentConnectId === connectIdRef.current) {
        console.error('[LiveAvatar] Connection error:', err);
        setErrorMessage(err.message || 'Failed to connect to Live Avatar stream');
        setStatus('error');
        teardown();
      }
    }
  }, [avatarId, avatarBackgroundId, avatarPrompt, avatarVoice, customPrompt, teardown, getCandidateBases, setAvatarMode, setGeminiLiveMode]);

  // Start session automatically on mount or when avatar changes
  useEffect(() => {
    startSession();
    return () => {
      teardown();
    };
  }, [avatarId, avatarBackgroundId]);

  // Toggle Microphone Mute
  const toggleMute = () => {
    if (localStreamRef.current) {
      const track = localStreamRef.current.getAudioTracks()[0];
      if (track) {
        track.enabled = !track.enabled;
        setIsMuted(!track.enabled);
      }
    }
  };

  const handleApplyPrompt = () => {
    setAvatarPrompt(customPrompt);
    setShowPromptModal(false);
    startSession();
  };

  const handleDeleteAvatar = async (targetId: string) => {
    if (!confirm(`Are you sure you want to delete custom avatar "${targetId.toUpperCase()}"?\n\nThis will permanently delete its portrait, voice clone, and GPU neural weights.`)) {
      return;
    }
    try {
      const bases = getCandidateBases();
      const base = bases[0];
      if (!base) throw new Error('Not connected to a Jarvis server');
      const res = await fetch(`${base}/api/avatar/${targetId}`, { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to delete avatar (${res.status})`);
      }
      setAvatarsList(prev => prev.filter(a => a !== targetId));
      if (avatarId === targetId) {
        setAvatarId(DEFAULT_AVATAR);
        setAvatarVoice('Kore');
      }
    } catch (err: any) {
      console.error('Delete avatar error:', err);
      alert(err.message || 'Failed to delete avatar');
    }
  };

  const handleCloseCreateModal = useCallback(() => {
    setShowCreateAvatarModal(false);
  }, []);

  const handleAvatarCreated = useCallback((newId: string) => {
    setAvatarsList(prev => prev.includes(newId) ? prev : [newId, ...prev]);
    const job = avatarTrainingJobs?.[newId];
    if (!job || job.status === 'ready') {
      setAvatarId(newId);
    }
  }, [avatarTrainingJobs, setAvatarId]);

  return (
    <div 
      className="w-full h-full relative flex flex-col items-center justify-between p-2 pointer-events-auto select-none overflow-hidden"
      onClick={onClick}
    >
      {/* Background Glow */}
      <div 
        className="absolute inset-0 pointer-events-none transition-all duration-700"
        style={{
          background: isSpeakingLive 
            ? 'radial-gradient(circle at center, rgba(34,211,238,0.22) 0%, rgba(34,211,238,0.06) 45%, transparent 70%)'
            : 'radial-gradient(circle at center, rgba(34,211,238,0.1) 0%, rgba(0,0,0,0) 65%)'
        }}
      />

      {/* Main HUD Frame */}
      <div className="relative w-full max-w-5xl h-full flex flex-col items-center justify-between pointer-events-auto min-h-0">
        
        {/* Active Avatar Generation / Training Progress Bar Banner (Async Mode) */}
        <AnimatePresence>
          {activeTrainingJobs.map((job) => (
            <motion.div
              key={job.avatarId}
              initial={{ opacity: 0, y: -20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.95 }}
              className="w-full max-w-lg mb-2 bg-[#060d17]/95 backdrop-blur-xl border border-accent-cyan/60 rounded-2xl p-3 shadow-2xl shadow-accent-cyan/20 z-50 pointer-events-auto"
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin text-accent-cyan" />
                  <span className="text-xs font-bold text-accent-cyan tracking-wide">
                    TRAINING AVATAR: {job.name}
                  </span>
                </div>
                <span className="text-xs font-bold text-white bg-accent-cyan/20 px-2 py-0.5 rounded-md border border-accent-cyan/30">
                  {job.progress}%
                </span>
              </div>

              {/* Glowing progress track */}
              <div className="w-full h-2 bg-black/70 rounded-full overflow-hidden border border-accent-cyan/30 p-[1px]">
                <div
                  className="h-full bg-gradient-to-r from-accent-cyan via-teal-400 to-emerald-400 rounded-full transition-all duration-500 shadow-[0_0_12px_rgba(0,240,255,0.8)]"
                  style={{ width: `${job.progress}%` }}
                />
              </div>

              <div className="flex items-center justify-between mt-1.5 text-[10px] text-white/70">
                <span className="truncate max-w-[80%]">{job.step}</span>
                <span className="text-accent-cyan/70 font-semibold">On the GPU</span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Top Control Bar */}
        <div className="w-full flex items-center justify-between flex-wrap gap-2 bg-[rgba(8,18,30,0.72)] backdrop-blur-xl border border-stroke px-2.5 py-1.5 rounded-[18px] z-40 mb-2 shrink-0">
          
          {/* Status Badge */}
          <div className="flex items-center gap-2 pr-3 border-r border-primary/20">
            <span className={`w-2.5 h-2.5 rounded-full ${
              status === 'live' ? 'bg-green-400 shadow-[0_0_8px_#4ade80] animate-pulse' :
              status === 'connecting' ? 'bg-yellow-400 shadow-[0_0_8px_#facc15] animate-ping' :
              'bg-red-400'
            }`} />
            <span className="t-subhead text-text">
              {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}
            </span>
          </div>

          {/* Avatar Selector Dropdown */}
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setShowAvatarMenu(!showAvatarMenu); setShowBgMenu(false); }}
              className="flex items-center gap-2 px-4 py-1.5 bg-accent-cyan/10 hover:bg-accent-cyan/20 border border-accent-cyan/30 rounded-full text-xs text-accent-cyan font-bold tracking-wide transition-all"
            >
              <User size={13} />
              <span className="capitalize">{avatarId || 'maria'}</span>
              <ChevronDown size={12} className={`transition-transform ${showAvatarMenu ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
              {showAvatarMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10, scale: 0.95 }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 top-full mt-2 w-64 max-h-72 overflow-y-auto bg-[#060d17]/95 backdrop-blur-2xl border border-accent-cyan/40 rounded-xl p-2 shadow-2xl z-50 scrollbar-thin"
                >
                  <div className="flex items-center justify-between text-[9px] text-primary/40 tracking-wide px-2 py-1 border-b border-primary/10 mb-1">
                    <span>Select Avatar Model</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAvatarMenu(false);
                      setShowCreateAvatarModal(true);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 mb-1.5 rounded-lg text-xs font-bold text-black bg-accent-cyan hover:bg-accent-cyan/90 transition-all shadow-md shadow-accent-cyan/20"
                  >
                    <Plus size={13} />
                    <span>Create a new avatar</span>
                  </button>
                  {Array.from(new Set([
                    ...Object.keys(avatarTrainingJobs || {}).filter(k => avatarTrainingJobs[k]?.status === 'training'),
                    ...avatarsList
                  ])).map((av) => {
                    const job = avatarTrainingJobs?.[av];
                    const isGenerating = job && job.status === 'training';
                    return (
                      <button
                        key={av}
                        disabled={isGenerating}
                        onClick={() => { 
                          if (isGenerating) return;
                          setAvatarId(av); 
                          setAvatarVoice(getAvatarVoice(av));
                          setShowAvatarMenu(false);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all ${
                          isGenerating
                            ? 'opacity-60 cursor-not-allowed bg-amber-500/10 border border-dashed border-amber-500/30 text-amber-300 select-none'
                            : avatarId === av 
                              ? 'bg-accent-cyan/20 text-accent-cyan font-bold' 
                              : 'text-primary/70 hover:bg-primary/10 hover:text-primary'
                        }`}
                        title={isGenerating ? `Avatar "${job?.name || av}" is generating on GPU (${job?.progress}%)...` : undefined}
                      >
                        <div className="flex items-center gap-2">
                          <span className="uppercase">{av}</span>
                          {isGenerating && (
                            <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                              <Loader2 size={10} className="animate-spin" />
                              {job.progress}%
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {avatarId === av && !isGenerating && <Check size={12} className="text-accent-cyan" />}
                          {!DEFAULT_AVATARS.includes(av.toLowerCase()) && !isGenerating && (
                            <span
                              role="button"
                              title={`Delete avatar "${av}"`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteAvatar(av);
                              }}
                              className="p-1 rounded hover:bg-rose-500/20 text-white/30 hover:text-rose-400 transition-colors"
                            >
                              <Trash2 size={12} />
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Background Selector Dropdown */}
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setShowBgMenu(!showBgMenu); setShowAvatarMenu(false); }}
              className="flex items-center gap-2 px-4 py-1.5 bg-black/40 hover:bg-accent-cyan/10 border border-primary/20 hover:border-accent-cyan/30 rounded-full text-xs text-primary/80 hover:text-accent-cyan tracking-wide transition-all"
            >
              <Image size={13} />
              <span className="capitalize">{avatarBackgroundId?.replace('_', ' ') || 'plain white'}</span>
              <ChevronDown size={12} className={`transition-transform ${showBgMenu ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
              {showBgMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10, scale: 0.95 }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 top-full mt-2 w-56 max-h-64 overflow-y-auto bg-[#060d17]/95 backdrop-blur-2xl border border-accent-cyan/40 rounded-xl p-2 shadow-2xl z-50 scrollbar-thin"
                >
                  <div className="text-[9px] text-primary/40 tracking-wide px-2 py-1 border-b border-primary/10 mb-1">
                    Select Background Scene
                  </div>
                  {backgroundsList.map((bg) => (
                    <button
                      key={bg}
                      onClick={() => { 
                        setAvatarBackgroundId(bg); 
                        setShowBgMenu(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all ${
                        avatarBackgroundId === bg 
                          ? 'bg-accent-cyan/20 text-accent-cyan font-bold' 
                          : 'text-primary/70 hover:bg-primary/10 hover:text-primary'
                      }`}
                    >
                      <span className="uppercase">{bg.replace('_', ' ')}</span>
                      {avatarBackgroundId === bg && <Check size={12} className="text-accent-cyan" />}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Persona / System Prompt Modal Button */}
          <button
            onClick={(e) => { e.stopPropagation(); setShowPromptModal(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-black/40 hover:bg-accent-cyan/10 border border-primary/20 hover:border-accent-cyan/30 rounded-full text-xs text-primary/80 hover:text-accent-cyan tracking-wide transition-all"
            title="Configure System Prompt & Persona"
          >
            <Sparkles size={12} className="text-yellow-400" />
            <span>Persona</span>
          </button>

          {/* Microphone Mute Toggle */}
          {status === 'live' && (
            <button
              onClick={(e) => { e.stopPropagation(); toggleMute(); }}
              className={`p-1.5 rounded-full border transition-all ${
                isMuted 
                  ? 'bg-red-500/20 border-red-500/50 text-red-400' 
                  : 'bg-accent-cyan/10 border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/20'
              }`}
              title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
            >
              {isMuted ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
          )}

          {/* Reconnect Button */}
          <button
            onClick={(e) => { e.stopPropagation(); startSession(); }}
            className="p-2 rounded-full bg-black/40 border border-primary/20 hover:border-accent-cyan/40 text-primary/60 hover:text-accent-cyan transition-all"
            title="Reconnect Live Session"
          >
            <RefreshCw size={14} className={status === 'connecting' ? 'animate-spin' : ''} />
          </button>

        </div>

        {/* Video Canvas / Live Avatar Video */}
        <div className="relative w-full flex-1 min-h-0 rounded-[20px] overflow-hidden border border-stroke bg-black/60 flex items-center justify-center">
          

          {/* Live Video Element (streamed from the AVTR-1 TensorRT renderer) */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            disablePictureInPicture
            style={{
              transform: 'translate3d(0, 0, 0)',
              WebkitTransform: 'translate3d(0, 0, 0)',
              willChange: 'transform',
            }}
            className={`w-full h-full object-cover transition-opacity duration-300 ${status === 'live' ? 'opacity-100' : 'opacity-0'}`}
          />

          {/* Hidden Audio Element */}
          <audio ref={audioRef} autoPlay />

          {/* Every avatar is labeled as AI (terms: custom avatars and cloned voices). */}
          <span className="absolute top-2.5 right-2.5 z-20 pointer-events-none rounded-full border border-white/25 bg-black/60 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white/85" aria-label="AI-generated avatar">
            AI avatar
          </span>

          {/* Overlay when Connecting or Error */}
          {status !== 'live' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10 bg-black/80 backdrop-blur-md">
              {status === 'connecting' ? (
                <div className="flex flex-col items-center gap-4">
                  <div className="relative w-16 h-16 flex items-center justify-center">
                    <motion.div 
                      className="absolute inset-0 rounded-full border-2 border-accent-cyan border-t-transparent"
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
                    />
                    <Sparkles size={24} className="text-accent-cyan animate-pulse" />
                  </div>
                  <div className="text-sm tracking-wide text-accent-cyan font-bold">
                    Starting the live avatar…
                  </div>
                  <div className="text-[10px] tracking-wide text-primary/40">
                    Connecting to the avatar GPU and Gemini Live
                  </div>
                </div>
              ) : status === 'error' ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="text-red-400 text-sm font-bold tracking-wide">
                    Couldn’t connect
                  </div>
                  <div className="text-[11px] text-red-300/70 max-w-md">
                    {errorMessage || 'Failed to connect to Live Avatar server.'}
                  </div>
                  <button
                    onClick={startSession}
                    className="mt-2 px-5 py-2 bg-accent-cyan/20 border border-accent-cyan/50 text-accent-cyan rounded-full text-xs font-bold tracking-wide hover:bg-accent-cyan/30 transition-all"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <button
                  onClick={startSession}
                  className="px-6 py-3 bg-accent-cyan/20 border border-accent-cyan/50 text-accent-cyan rounded-full text-xs font-bold tracking-wide hover:bg-accent-cyan/30 shadow-[0_0_20px_rgba(34,211,238,0.3)] transition-all"
                >
                  Start the live avatar
                </button>
              )}
            </div>
          )}

          {/* Mode Indicator Watermark Badge on Video */}
          <div className="absolute top-4 left-4 z-20 pointer-events-none">
            <span className="px-2.5 py-1 bg-black/60 backdrop-blur-md border border-primary/20 rounded-full text-[9px] tracking-wide text-primary/70">
              Real-time voice
            </span>
          </div>

          {/* Subtitle / Live Transcript Pill */}
          {voiceState.transcript && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 max-w-[90%] pointer-events-none">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="t-callout text-text bg-[rgba(8,18,30,0.8)] px-5 py-2 rounded-[16px] border border-stroke-strong backdrop-blur-xl text-center"
              >
                {voiceState.transcript}
              </motion.div>
            </div>
          )}
        </div>
      </div>

      {/* System Prompt Customization Modal */}
      <AnimatePresence>
        {showPromptModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowPromptModal(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-xl bg-[#060d17]/95 border border-accent-cyan/40 rounded-2xl p-6 shadow-2xl flex flex-col gap-4"
            >
              <div className="flex items-center justify-between border-b border-primary/20 pb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="text-yellow-400" size={18} />
                  <span className="text-sm font-bold text-accent-cyan tracking-wide">
                    AVATAR SYSTEM PROMPT & PERSONA
                  </span>
                </div>
                <button
                  onClick={() => setShowPromptModal(false)}
                  className="text-primary/40 hover:text-primary transition-colors text-xs"
                >
                  ESC / CLOSE
                </button>
              </div>

              {/* Presets */}
              <div>
                <div className="text-[10px] text-primary/40 tracking-wide mb-2">
                  Quick Persona Presets
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {PROMPT_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => setCustomPrompt(preset.prompt)}
                      className="px-3 py-2 bg-black/40 hover:bg-accent-cyan/10 border border-primary/20 hover:border-accent-cyan/40 rounded-lg text-left transition-all"
                    >
                      <div className="text-[11px] font-bold text-accent-cyan">{preset.name}</div>
                      <div className="text-[8px] text-primary/40 line-clamp-1">{preset.prompt}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Textarea */}
              <div>
                <div className="text-[10px] text-primary/40 tracking-wide mb-2">
                  Custom System Instructions
                </div>
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  rows={5}
                  placeholder="Enter custom instructions for the live avatar..."
                  className="w-full p-3 bg-black/60 border border-primary/30 rounded-xl text-primary text-xs focus:border-accent-cyan focus:outline-none scrollbar-thin resize-none leading-relaxed"
                />
              </div>

              {/* Voice / Engine Settings */}
              <div>
                <div className="text-[10px] text-primary/40 tracking-wide mb-2">
                  Gemini Live Voice
                </div>
                <div className="flex gap-2">
                  {GEMINI_VOICES.map((v) => (
                    <button
                      key={v}
                      onClick={() => setAvatarVoice(v)}
                      className={`px-3 py-1.5 rounded-lg text-[11px] border transition-all ${
                        avatarVoice === v 
                          ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan font-bold' 
                          : 'bg-black/40 border-primary/20 text-primary/60 hover:text-primary'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end gap-3 pt-3 border-t border-primary/20">
                <button
                  onClick={() => setShowPromptModal(false)}
                  className="px-4 py-2 border border-primary/20 text-primary/60 hover:text-primary rounded-xl text-xs tracking-wide"
                >
                  CANCEL
                </button>
                <button
                  onClick={handleApplyPrompt}
                  className="px-6 py-2 bg-accent-cyan text-[#060d17] font-bold rounded-xl text-xs tracking-wide hover:bg-accent-cyan/80 shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-all"
                >
                  APPLY & RESTART
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <CreateAvatarModal
        isOpen={showCreateAvatarModal}
        onClose={handleCloseCreateModal}
        onAvatarCreated={handleAvatarCreated}
      />
    </div>
  );
};
