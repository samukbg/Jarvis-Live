import { create } from 'zustand';
import { detectSpecialContent } from './components/overlayCards/detectSpecialContent';
import {
  normalizeHost, resolveServer, ServerUnavailableError, wsUrlFor,
  type ResolvedServer, type ServerSettings,
} from './server/serverConnection';

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: 'IDLE' | 'THINKING' | 'WRITING' | 'ERROR';
  tasks: string[];
  load: number;
  description?: string;
  prompt?: string;
}

export interface AgentOutcome {
  agentId: string;
  agentName: string;
  result: string;
}

export interface FeedItem {
  tag: string;
  title: string;
  source: string;
  time: string;
  link: string;
}

export interface Notification {
  id: string;
  label: string;
  msg: string;
  kind: 'info' | 'warn' | 'success';
  time: string;
}

export interface Telemetry {
  cpu: number;
  ram: number;
}

export interface CryptoData {
  address: string;
  balanceBase: string;
  ethPrice: string;
  ethChange: string;
  totalUsd: string;
}

export interface HealthData {
  connected: boolean;
  recovery?: number;
  sleep?: number;
  hrv?: number;
  rhr?: number;
  strain?: number;
  steps?: number;
  calories?: number;
  synced_at?: string;
}

export interface SpotifyState {
  state: string;
  track: string;
  artist: string;
}

interface VoiceState {
  isListening: boolean;
  isSpeaking: boolean;
  transcript: string;
  role: 'user' | 'assistant';
}

// Store audio data outside of React state to prevent 60fps re-renders
export const audioVisualizerData = {
  data: Array(32).fill(0)
};

/** An agent id reported by the server (/api/agents): 'gemini' (agy), 'claude', 'hermes', 'codex'… */
export type AiModel = string;

export interface DetectedAgent {
  id: string;
  cli: string;
  name: string;
  vendor: string;
  version: string;
  driven: boolean;
  models: string[];
}

export interface AvatarTrainingJob {
  avatarId: string;
  name: string;
  gender?: string;
  voice?: string;
  status: 'training' | 'ready' | 'failed';
  progress: number;
  step: string;
  startedAt: number;
  error?: string | null;
}

interface AppState {
  screen: 'orchestrator' | 'command';
  setScreen: (screen: 'orchestrator' | 'command') => void;
  aiModel: AiModel;
  setAiModel: (model: AiModel) => void;
  selectedModels: Record<AiModel, string>;
  setSelectedModel: (agent: AiModel, model: string) => void;
  agents: Agent[];
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  logs: string[];
  addLog: (log: string) => void;
  clearLogs: () => void;
  voiceState: VoiceState;
  setVoiceState: (updates: Partial<VoiceState>) => void;
  streams: Record<string, string>;
  appendStream: (agentId: string, token: string) => void;
  sendCommand: (cmd: string) => void;
  toggleMic: () => void;
  feed: FeedItem[];
  notifications: Notification[];
  addNotification: (n: Omit<Notification, 'id' | 'time'>) => void;
  telemetry: Telemetry;
  crypto: CryptoData | null;
  health: HealthData;
  spotify: SpotifyState;
  spotifyAction: (action: string, value?: number) => Promise<void>;
  quickAction: (name: string) => Promise<void>;
  activeAgentConnections: string[];
  agentOutcome: AgentOutcome | null;
  dismissOutcome: () => void;
  language: string;
  setLanguage: (lang: string) => void;
  isTtsLoading: boolean;
  setTtsLoading: (loading: boolean) => void;
  avatarMode: boolean;
  setAvatarMode: (mode: boolean) => void;
  onAvatarAudio: ((data: ArrayBuffer, isPcm: boolean, format: string) => void) | null;
  setOnAvatarAudio: (fn: ((data: ArrayBuffer, isPcm: boolean, format: string) => void) | null) => void;
  onAvatarFrame: ((frame: ArrayBuffer) => void) | null;
  setOnAvatarFrame: (fn: ((frame: ArrayBuffer) => void) | null) => void;
  sendBinaryMessage: (data: ArrayBuffer) => void;
  geminiLiveMode: boolean;
  setGeminiLiveMode: (enabled: boolean) => void;
  cameraActive: boolean;
  toggleCamera: () => Promise<void>;
  screenActive: boolean;
  toggleScreen: () => Promise<void>;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  hostUrl: string;
  /** Your Jarvis server: hostUrl + apiKey. */
  apiKey: string;
  /** The server in use now ('' until connected) and why it isn't, if it isn't. */
  activeServerUrl: string;
  activeServerName: string;
  serverError: string | null;
  /** The WebSocket to the server is open (voice, logs and cards flow). */
  wsConnected: boolean;
  /** Agents installed on the active server that Jarvis can drive (detected, not hardcoded). */
  installedAgents: DetectedAgent[];
  refreshAgents: () => Promise<void>;
  appLanguage: string;
  ttsServer: string;
  cryptoWallet: string;
  newsRssUrl: string;
  availableModels: Record<AiModel, string[]>;
  avatarGender: 'female' | 'male';
  setAvatarGender: (gender: 'female' | 'male') => void;
  avatarId: string;
  setAvatarId: (id: string) => void;
  avatarBackgroundId: string;
  setAvatarBackgroundId: (id: string) => void;
  avatarPrompt: string;
  setAvatarPrompt: (prompt: string) => void;
  avatarServerUrl: string;
  setAvatarServerUrl: (url: string) => void;
  avatarVoice: string;
  setAvatarVoice: (voice: string) => void;
  avatarTrainingJobs: Record<string, AvatarTrainingJob>;
  setAvatarTrainingJob: (job: AvatarTrainingJob) => void;
  removeAvatarTrainingJob: (avatarId: string) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (settings: { hostUrl?: string; apiKey?: string; appLanguage?: string; ttsServer?: string; cryptoWallet?: string; newsRssUrl?: string; avatarId?: string; avatarServerUrl?: string; avatarBackgroundId?: string; avatarPrompt?: string; avatarVoice?: string }) => Promise<void>;
}

// Your Jarvis server: by default the one that serves this page (the dev server proxies /api
// and /ws to its backend). Audio (the WebSocket) and video (the live avatar) both go to that
// server. The API key is never baked into the page: you enter it in Settings → Server.
const defaultHost = (): string => {
  if (typeof window !== 'undefined' && /^https?:$/.test(window.location?.protocol || '')) return window.location.origin;
  return normalizeHost(import.meta.env.VITE_BACKEND_HTTP || '');
};
/** Optional build-time key (VITE_JARVIS_API_KEY) for a private build; empty by default. */
const ENV_API_KEY: string = import.meta.env.VITE_JARVIS_API_KEY || '';
export let BACKEND_HTTP = '';
export let BACKEND_WS = '';
/** The active server's API key. */
export let API_KEY = '';
let activeServer: ResolvedServer | null = null;

/** Point every request at `server` (WebSocket, HTTP, live avatar). */
const setActiveServer = (server: ResolvedServer | null) => {
  activeServer = server;
  BACKEND_HTTP = server?.url || '';
  BACKEND_WS = server ? wsUrlFor(server.url) : '';
  API_KEY = server?.key || '';
};

/** The live avatar a new install starts with. */
export const DEFAULT_AVATAR = 'maria';

export const useStore = create<AppState>((set, get) => {
  let ws: WebSocket | null = null;
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let outputAnalyser: AnalyserNode | null = null;
  let outputAnimFrame = 0;
  let scriptProcessor: ScriptProcessorNode | null = null;
  let nextPlayTime = 0;
  let startTime = 0;
  
  // Vision capture references
  let cameraCapture: import('./utils/vision').VisionCapture | null = null;
  let screenCapture: import('./utils/vision').VisionCapture | null = null;

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Keep the chosen avatar to one this server has (servers don't all have the same portraits). */
  const alignAvatar = async () => {
    if (!BACKEND_HTTP) return;
    try {
      const res = await fetch(`${BACKEND_HTTP}/api/avatar/avatars`, { headers: { 'x-api-key': API_KEY } });
      const list: string[] = res.ok ? ((await res.json()).avatars || []).map((a: string) => a.toLowerCase()) : [];
      const current = (get().avatarId || '').toLowerCase();
      if (!list.length || list.includes(current)) return;
      const next = list.includes(DEFAULT_AVATAR) ? DEFAULT_AVATAR : list[0];
      get().setAvatarId(next);
      get().addLog(`[SYSTEM] Avatar "${current}" isn't on this server — using "${next}".`);
    } catch {}
  };
  let promptedSetup = false;
  let failedConnects = 0;
  const serverSettings = (): ServerSettings => {
    const st = get();
    return { hostUrl: st.hostUrl, apiKey: st.apiKey };
  };
  const scheduleReconnect = (ms: number) => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, ms);
  };
  /** Forget the current server (settings changed): the next connect resolves it again. */
  const dropServer = () => {
    setActiveServer(null);
    failedConnects = 0;
    set({ activeServerUrl: '', activeServerName: '' });
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch (e) {}
      ws = null;
    }
  };

  const connectWS = async () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (!activeServer) {
      try {
        const server = await resolveServer(serverSettings());
        setActiveServer(server);
        set({ activeServerUrl: server.url, activeServerName: server.name, avatarServerUrl: server.url, serverError: null });
        get().addLog(`[SYSTEM] Server: ${server.name}`);
        fetchInitialRestData();
      } catch (e: any) {
        const message = e?.message || String(e);
        set({ serverError: message });
        get().addLog(`[SYSTEM] ${message}`);
        // Something to fill in (URL, API key): show Settings once instead of retrying blindly.
        if (e instanceof ServerUnavailableError && e.needsSetup && !promptedSetup) {
          promptedSetup = true;
          set({ settingsOpen: true });
        }
        scheduleReconnect((e instanceof ServerUnavailableError ? e.retryAfterS : 15) * 1000);
        return;
      }
    }
    try {
      const sep = BACKEND_WS.includes('?') ? '&' : '?';
      ws = new WebSocket(`${BACKEND_WS}${sep}api_key=${encodeURIComponent(API_KEY)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        failedConnects = 0;
        set({ serverError: null, wsConnected: true });
        get().refreshAgents();
        alignAvatar();
        get().addLog('[SYSTEM] Connected to Jarvis backend.');
        // Request immediate state sync
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'get_state' }));
        }
      };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'state_sync':
              if (msg.activeModel !== undefined) set({ aiModel: msg.activeModel });
              if (msg.selectedModels !== undefined) set({ selectedModels: msg.selectedModels });
              if (msg.geminiLiveMode !== undefined) set({ geminiLiveMode: msg.geminiLiveMode });
              if (msg.activeLanguage !== undefined) set({ language: msg.activeLanguage });
              break;
            case 'log': get().addLog(msg.message); break;
            case 'wipe_logs': get().clearLogs(); break;
            case 'agent_status':
              get().updateAgent(msg.agentId, { status: msg.status, ...(msg.prompt ? { prompt: msg.prompt } : {}) });
              break;
            case 'stream': get().appendStream(msg.agentId, msg.token); break;
            case 'core_output_token':
              // tokens appear in CORE OUTPUT directly
              break;
            case 'alert': get().addLog(`[ALERT] ${msg.message}`); break;
            case 'notification':
              get().addNotification({ label: msg.label, msg: msg.msg, kind: msg.kind });
              break;
            case 'avatar_training_started': {
              const job: AvatarTrainingJob = msg.job;
              if (job) {
                get().setAvatarTrainingJob(job);
              }
              break;
            }
            case 'avatar_training_progress': {
              const job: AvatarTrainingJob = msg.job;
              if (job) {
                get().setAvatarTrainingJob(job);
              }
              break;
            }
            case 'avatar_training_completed': {
              const job: AvatarTrainingJob = msg.job;
              if (job) {
                get().setAvatarTrainingJob({ ...job, status: 'ready', progress: 100 });
              }
              get().addNotification({
                label: 'AVATAR READY',
                msg: `Avatar "${msg.name || msg.avatarId}" generated & active in GPU VRAM!`,
                kind: 'success'
              });
              setTimeout(() => {
                get().removeAvatarTrainingJob(msg.avatarId);
              }, 4000);
              break;
            }
            case 'avatar_training_failed': {
              const job: AvatarTrainingJob = msg.job;
              if (job) {
                get().setAvatarTrainingJob({ ...job, status: 'failed', error: msg.error });
              }
              get().addNotification({
                label: 'TRAINING FAILED',
                msg: `Failed to generate "${msg.name || msg.avatarId}": ${msg.error}`,
                kind: 'warn'
              });
              break;
            }
            case 'avatar_deleted': {
              const deletedId = msg.avatarId;
              if (deletedId) {
                if (get().avatarId === deletedId) {
                  get().setAvatarId(DEFAULT_AVATAR);
                  get().setAvatarVoice('Kore');
                  get().setAvatarGender('female');
                }
                get().removeAvatarTrainingJob(deletedId);
                get().addNotification({
                  label: 'AVATAR DELETED',
                  msg: `Avatar "${deletedId}" has been deleted.`,
                  kind: 'info'
                });
              }
              break;
            }
            case 'voice_transcript':
              const newRole = msg.role || 'user';
              set((state) => ({ 
                voiceState: { 
                  ...state.voiceState, 
                  transcript: msg.text, 
                  role: newRole 
                } 
              }));
              
              if (msg.is_final) {
                if (newRole === 'user') {
                  get().addLog(`You: ${msg.text}`);
                }

                // Keep the final transcript visible for a few seconds
                const timeout = newRole === 'assistant' ? 1500 : 3000;
                setTimeout(() => {
                  set((state) => {
                    // Only clear if no new speech has started
                    if (state.voiceState.transcript === msg.text) {
                      return { voiceState: { ...state.voiceState, transcript: '', role: 'user' } };
                    }
                    return {};
                  });
                }, timeout);
              }
              break;
            case 'voice_state':
              set((state) => ({
                voiceState: {
                  ...state.voiceState,
                  isSpeaking: msg.state === 'speaking',
                  // NOTE: isListening is NOT set here — it is only controlled
                  // by toggleMic.  voice_state messages are about TTS playback.
                }
              }));
              // Clear audio data when going idle so blob returns to rest
              if (msg.state === 'idle') {
                audioVisualizerData.data = Array(32).fill(0);
              }
              break;
            case 'tts_volume': {
              // Volume level (0–1) streamed from backend during TTS playback
              const lvl = Math.max(0, Math.min(1, msg.level));
              audioVisualizerData.data = Array(32).fill(Math.round(lvl * 255));
              break;
            }
            case 'tts_chunk':
              if (get().avatarMode) {
                break;
              }
              handleIncomingAudioBase64(msg.content, !!msg.isPcm, msg.format || 'mp3');
              break;
            case 'gemini_live_interrupt':
              // Gemini interrupted — clear audio queue immediately
              audioQueue.length = 0;
              activeNodes.forEach(n => { try { n.stop(); } catch(e){} });
              activeNodes = [];
              nextPlayTime = 0;
              set((state) => ({ voiceState: { ...state.voiceState, isSpeaking: false } }));
              break;
            case 'feed':
              set({ feed: msg.items });
              break;
            case 'telemetry':
              set({ telemetry: msg.data });
              break;
            case 'crypto':
              set({ crypto: msg.data });
              break;
            case 'health':
              set({ health: msg.data });
              break;
            case 'wake_detected':
              // Wake word heard via STT — activate mic if not already listening.
              // Requires prior mic permission (user must have clicked orb once this session).
              if (!get().voiceState.isListening) get().toggleMic();
              break;
            case 'tts_ready':
              set({ isTtsLoading: false });
              break;
            case 'agent_result': {
              const result = msg.content || msg.result || '';
              const lowerName = (msg.agentName || msg.agentId || '').toLowerCase();
              const special = detectSpecialContent(result, msg.agentName);
              const has3DMedia = /\.(glb|gltf|obj|stl|fbx)(\?|$|\s|\))/i.test(result) || result.includes('/api/local-image');

              // A task is delegated if:
              // 1. Explicitly flagged as delegated (msg.isDelegated === true)
              // 2. Produced by a dedicated worker execution agent (agy, claude, nexus, stark, athena, veronica, vision, etc.)
              // 3. Contains rich interactive artifacts that require the overlay to view (3D models, special domain cards, or code blocks)
              // Conversational talk (general answers, speech transcripts, chatter) MUST NOT trigger the overlay.
              const isWorkerAgent = lowerName.includes('agy') || 
                lowerName.includes('claude') || 
                lowerName.includes('nexus') || 
                lowerName.includes('stark') || 
                lowerName.includes('athena') || 
                lowerName.includes('veronica') || 
                lowerName.includes('vision') ||
                lowerName.includes('delegat');

              const isDelegatedTask = msg.isDelegated === true ||
                isWorkerAgent ||
                has3DMedia ||
                special !== null ||
                (result.includes('```') && isWorkerAgent);

              const shouldShowOverlay = (msg.isDelegated === false && !has3DMedia) ? false : isDelegatedTask;

              if (shouldShowOverlay) {
                set({ agentOutcome: {
                  agentId: msg.agentId || 'jarvis',
                  agentName: msg.agentName || 'JARVIS',
                  result,
                }});
              } else {
                console.info(`[CONVERSATIONAL TALK] ${msg.agentName}: ${result}`);
              }
              break;
            }
            case 'agent_conversation': {
              console.info(`[CONVERSATIONAL TALK] ${msg.agentName}: ${(msg.result || '').slice(0, 100)}`);
              break;
            }
            case 'agent_action': {
              // Action-only task (browser open, click, navigate, etc.)
              // Agent completed the action — no overlay needed, just log.
              console.info(`[JARVIS ACTION] ${msg.agentName}: ${(msg.result || '').slice(0, 200)}`);
              break;
            }
            case 'spotify':
              set({ spotify: msg.data });
              break;
          }
        } catch(e) {}
      } else {
        const buffer = event.data as ArrayBuffer;
        if (buffer && buffer.byteLength >= 12) {
          try {
            const view = new DataView(buffer);
            const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
            if (magic === 'AUDO') {
              // When avatarMode is active, WebRTC plays audio track in sync with video.
              if (get().avatarMode) {
                return;
              }
              if (get().onAvatarAudio) {
                try { get().onAvatarAudio!(buffer.slice(12), true, 'pcm'); } catch(e) {}
              }
              return;
            } else if (magic === 'VIDO') {
              const frameData = buffer.slice(12);
              if (get().onAvatarFrame) {
                get().onAvatarFrame!(frameData);
              }
              return;
            }
          } catch(e) {}
        }
        // When Live Avatar WebRTC is active, WebRTC plays audio directly with lip sync.
        // Skip redundant background WebAudio playback to prevent echo / duplicate audio.
        if (get().avatarMode || get().geminiLiveMode) {
          return;
        }
        handleIncomingAudio(buffer, true, 'pcm');
      }
    };

    ws.onerror = () => {
      try { ws?.close(); } catch(e) {}
    };
    ws.onclose = () => {
      failedConnects += 1;
      ws = null;
      set({ wsConnected: false });
      scheduleReconnect(3000);
    };
  } catch(err) {
    failedConnects += 1;
    scheduleReconnect(3000);
  }
};

  const handleIncomingAudioBase64 = async (base64: string, isPcm: boolean = false, format: string = 'mp3') => {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    handleIncomingAudio(bytes.buffer, isPcm, format);
  };

  let audioQueue: AudioBuffer[] = [];
  let isPlayingQueue = false;
  let activeNodes: AudioBufferSourceNode[] = [];

  const processAudioQueue = async () => {
    if (!audioContext || isPlayingQueue || audioQueue.length === 0) return;
    
    // now variable removed
    const LOOKAHEAD = 0.15; // 150ms safety window

    isPlayingQueue = true;

    while (audioQueue.length > 0) {
      let currentNow = audioContext.currentTime;

      // Throttle scheduling to prevent RAM blowout with fast streams
      while (nextPlayTime > currentNow + 1.0) {
        await new Promise(r => setTimeout(r, 50));
        currentNow = audioContext!.currentTime;
      }

      const buffer = audioQueue.shift();
      if (!buffer) continue;

      const sourceNode = audioContext.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.connect(outputAnalyser || audioContext.destination);

      if (nextPlayTime < currentNow) {
        nextPlayTime = currentNow + LOOKAHEAD;
      }

      const startAt = nextPlayTime;
      nextPlayTime += buffer.duration;

      activeNodes.push(sourceNode);
      sourceNode.onended = () => {
        activeNodes = activeNodes.filter(n => n !== sourceNode);
      };

      sourceNode.start(startAt);

      set((state) => ({ voiceState: { ...state.voiceState, isSpeaking: true } }));
      
      if (!outputAnimFrame) {
        const pollOutput = () => {
          if (!outputAnalyser) {
            outputAnimFrame = 0;
            (window as any).avatarVolume = 0;
            return;
          }
          const dataArray = new Uint8Array(outputAnalyser.frequencyBinCount);
          outputAnalyser.getByteFrequencyData(dataArray);
          audioVisualizerData.data = Array.from(dataArray);
          
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const val = dataArray[i] / 255.0;
            sum += val * val;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          (window as any).avatarVolume = Math.min(1.0, rms * 3.5);
          
          if (activeNodes.length > 0 || audioQueue.length > 0 || rms > 0.002) {
            outputAnimFrame = requestAnimationFrame(pollOutput);
          } else {
            outputAnimFrame = 0;
            (window as any).avatarVolume = 0;
            audioVisualizerData.data = Array(32).fill(0);
            set((state) => ({ voiceState: { ...state.voiceState, isSpeaking: false } }));
          }
        };
        pollOutput();
      }
    }

    isPlayingQueue = false;
  };

  const handleIncomingAudio = async (data: ArrayBuffer, isPcm: boolean = false, format: string = 'mp3') => {
    // When in avatar mode, audio is handled directly via WebRTC stream — skip WebAudio to prevent echo
    if (get().avatarMode) {
      return;
    }

    if (get().onAvatarAudio) {
      try { get().onAvatarAudio!(data, isPcm, format); } catch(e) {}
    }
    if (!audioContext) {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (!outputAnalyser && audioContext) {
      outputAnalyser = audioContext.createAnalyser();
      outputAnalyser.fftSize = 64;
      outputAnalyser.connect(audioContext.destination);
    }
    if (audioContext.state === 'suspended') await audioContext.resume();
    
    try {
      if (get().avatarMode && get().onAvatarAudio) {
        get().onAvatarAudio!(data, isPcm, format);
        if (!isPcm) return; // Let standard Audio processing handle PCM (Gemini Live) natively
      }

      if (isPcm) {
        // Raw 16-bit PCM (from Gemini Live)
        const safeLen = data.byteLength - (data.byteLength % 2);
        const int16 = new Int16Array(data.slice(0, safeLen));
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

        const buffer = audioContext.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);

        audioQueue.push(buffer);
        processAudioQueue();
      } else {
        // Standard media formats (MP3/WAV from Hermes TTS)
        // Use native HTML5 Audio for robust playback, avoiding decodeAudioData quirks
        const mimeType = (format === 'mp3') ? 'audio/mpeg' : 'audio/wav';
        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const audioEl = new Audio(url);
        
        set((state) => ({ voiceState: { ...state.voiceState, isSpeaking: true } }));
        audioEl.onended = () => {
          URL.revokeObjectURL(url);
          set((state) => ({ voiceState: { ...state.voiceState, isSpeaking: false } }));
        };
        audioEl.onerror = () => {
          URL.revokeObjectURL(url);
          set((state) => ({ voiceState: { ...state.voiceState, isSpeaking: false } }));
        };
        
        // Fake volume visualization for HTML5 audio
        if (!outputAnimFrame) {
          const fakePoll = () => {
            if (!get().voiceState.isSpeaking) {
              outputAnimFrame = 0;
              return;
            }
            audioVisualizerData.data = Array(32).fill(0).map(() => Math.random() * 100 + 50);
            outputAnimFrame = requestAnimationFrame(fakePoll);
          };
          fakePoll();
        }
        
        audioEl.play().catch(e => console.error('[Web Audio] HTML5 play error:', e));
      }
    } catch (e) {
      console.error('[Web Audio] Decode error:', e);
    }
  };

  const startAudioCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 24000, echoCancellation: true, noiseSuppression: true } });
      if (!audioContext) {
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      if (!outputAnalyser && audioContext) {
        outputAnalyser = audioContext.createAnalyser();
        outputAnalyser.fftSize = 64;
        outputAnalyser.connect(audioContext.destination);
      }
      source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);
      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);
      startTime = Date.now();

      scriptProcessor.onaudioprocess = (e) => {
        e.outputBuffer.getChannelData(0).fill(0); // prevent mic passthrough to speakers
        if (!get().voiceState.isListening) return;
        const dataArray = new Uint8Array(analyser!.frequencyBinCount);
        analyser!.getByteFrequencyData(dataArray);
        audioVisualizerData.data = Array.from(dataArray);
        const inputData = e.inputBuffer.getChannelData(0);
        const buffer = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          buffer[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        const header = new ArrayBuffer(8);
        const view = new DataView(header);
        view.setUint32(0, Date.now() - startTime, false);
        view.setUint32(4, 0, false);
        const combined = new Uint8Array(8 + buffer.byteLength);
        combined.set(new Uint8Array(header), 0);
        combined.set(new Uint8Array(buffer.buffer), 8);
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(combined.buffer);
      };
    } catch(e) {
      get().addLog('[ERROR] Mic access denied.');
    }
  };

  const fetchInitialRestData = async () => {
    try {
      if (!BACKEND_HTTP) return;
      const authQuery = `?api_key=${encodeURIComponent(API_KEY)}`;
      fetch(`${BACKEND_HTTP}/api/feed${authQuery}`)
        .then(r => r.json())
        .then(d => { if (d.items && d.items.length > 0) set({ feed: d.items }); })
        .catch(() => {});

      fetch(`${BACKEND_HTTP}/api/crypto${authQuery}`)
        .then(r => r.json())
        .then(d => { if (d.data) set({ crypto: d.data }); })
        .catch(() => {});

      fetch(`${BACKEND_HTTP}/api/telemetry${authQuery}`)
        .then(r => r.json())
        .then(d => { if (d.data) set({ telemetry: d.data }); })
        .catch(() => {});
    } catch(e) {}
  };

  if (typeof window !== 'undefined') {
    setTimeout(() => {
      get().loadSettings().then(connectWS);
    }, 0);
  }

  return {
    screen: 'command',
  setScreen: (screen) => set({ screen }),
  
  aiModel: 'gemini',
  setAiModel: (model) => {
    set({ aiModel: model });
    // Notify server of model change
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_model', model }));
    }
  },

    installedAgents: [],
    refreshAgents: async () => {
      if (!BACKEND_HTTP) return;
      try {
        const res = await fetch(`${BACKEND_HTTP}/api/agents`, { headers: { 'x-api-key': API_KEY } });
        if (!res.ok) return;
        const detected: DetectedAgent[] = (await res.json()).agents || [];
        const agents = detected.filter((a) => a.driven);
        const availableModels = Object.fromEntries(agents.map((a) => [a.id, a.models]));
        const prev = get().selectedModels;
        // Keep each agent's chosen model if this server has it, else its first model.
        const selectedModels = Object.fromEntries(
          agents.filter((a) => a.models.length).map((a) => [a.id, a.models.includes(prev[a.id]) ? prev[a.id] : a.models[0]]),
        );
        const aiModel = agents.some((a) => a.id === get().aiModel) ? get().aiModel : agents[0]?.id ?? get().aiModel;
        // Status cards: the voice layer always, CLI agents only when installed on this server.
        const installedClis = new Set(detected.map((a) => a.cli));
        const CARD_CLI: Record<string, string> = { hermes: 'hermes', claude: 'claude', agy: 'agy', codex: 'codex', openclaw: 'openclaw' };
        const cards = get().agents.filter((c) => !CARD_CLI[c.id] || installedClis.has(CARD_CLI[c.id]));
        for (const a of detected) {
          const cardId = a.id === 'gemini' ? 'agy' : a.id;
          if (!cards.some((c) => c.id === cardId) && CARD_CLI[cardId]) {
            cards.push({ id: cardId, name: a.name.toUpperCase(), role: a.vendor, description: a.version, status: 'IDLE', tasks: [], load: 0 } as Agent);
          }
        }
        set({ installedAgents: agents, agents: cards, availableModels, selectedModels, aiModel });
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'set_model', model: aiModel }));
          for (const [agent, model] of Object.entries(selectedModels)) {
            ws.send(JSON.stringify({ type: 'set_specific_model', agent, model }));
          }
        }
      } catch (e) {
        console.warn('[AGENTS] detection fetch failed', e);
      }
    },
    availableModels: {},
    selectedModels: {},
  setSelectedModel: (agent, model) => {
    set((state) => ({
      selectedModels: { ...state.selectedModels, [agent]: model }
    }));
    // Notify server of specific model change
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_specific_model', agent, model }));
    }
  },
  language: 'en',
  isTtsLoading: false,
  setTtsLoading: (loading) => set({ isTtsLoading: loading }),
  avatarMode: false,
  setAvatarMode: (mode) => set({ avatarMode: mode }),
  onAvatarAudio: null,
  setOnAvatarAudio: (fn) => set({ onAvatarAudio: fn }),
  onAvatarFrame: null,
  setOnAvatarFrame: (fn) => set({ onAvatarFrame: fn }),
  sendBinaryMessage: (data: ArrayBuffer) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  },
  setLanguage: (lang) => {
    set({ language: lang, isTtsLoading: true });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_language', language: lang }));
    }
  },
  geminiLiveMode: true,
    setGeminiLiveMode: (enabled: boolean) => {
      set({ geminiLiveMode: enabled });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_gemini_live_mode', enabled }));
      }
      if (!enabled) {
        if (get().cameraActive) get().toggleCamera();
        if (get().screenActive) get().toggleScreen();
      }
    },
    cameraActive: false,
    toggleCamera: async () => {
      const state = get();
      if (state.cameraActive) {
        if (cameraCapture) {
          cameraCapture.stop();
          cameraCapture = null;
        }
        set({ cameraActive: false });
      } else {
        if (state.screenActive) await get().toggleScreen();
        const { VisionCapture } = await import('./utils/vision');
        cameraCapture = new VisionCapture(false);
        const success = await cameraCapture.start((base64) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'vision_frame', mimeType: 'image/jpeg', data: base64 }));
          }
        });
        if (success) set({ cameraActive: true });
      }
    },
    screenActive: false,
    toggleScreen: async () => {
      const state = get();
      if (state.screenActive) {
        if (screenCapture) {
          screenCapture.stop();
          screenCapture = null;
        }
        set({ screenActive: false });
      } else {
        if (state.cameraActive) await get().toggleCamera();
        const { VisionCapture } = await import('./utils/vision');
        screenCapture = new VisionCapture(true);
        const success = await screenCapture.start((base64) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'vision_frame', mimeType: 'image/jpeg', data: base64 }));
          }
        });
        if (success) set({ screenActive: true });
      }
    },

    agents: [
      { id: 'jarvis', name: 'JARVIS', role: 'MASTER ORCHESTRATOR', description: 'Just A Rather Very Intelligent System', status: 'IDLE', tasks: ['System Online'], load: 12 },
      { id: 'hermes', name: 'HERMES', role: 'Local Execution', description: 'Advanced local CLI orchestration', status: 'IDLE', tasks: [], load: 0 },
      { id: 'gemini', name: 'GEMINI', role: 'Multimodal Voice', description: 'Real-time conversational interface', status: 'IDLE', tasks: [], load: 0 },
      { id: 'claude', name: 'CLAUDE', role: 'Deep Analysis', description: 'Complex reasoning and synthesis', status: 'IDLE', tasks: [], load: 0 },
      { id: 'agy',    name: 'AGY',    role: 'Autonomous System', description: 'Antigravity workspace interaction', status: 'IDLE', tasks: [], load: 0 }
    ],
    updateAgent: (id, updates) => set((state) => ({
      agents: state.agents.map(a => a.id === id ? { ...a, ...updates } : a),
      activeAgentConnections: updates.status && updates.status !== 'IDLE'
        ? [...new Set([...state.activeAgentConnections, id])]
        : state.activeAgentConnections.filter(aid => aid !== id),
    })),
    logs: [],
    addLog: (log) => set((state) => ({
      logs: [...state.logs.slice(-200),
        `[${new Date().toLocaleTimeString([], { hour12: false })}]${log}`],
    })),
    clearLogs: () => set({ logs: [] }),
    voiceState: {
      isListening: false,
      isSpeaking: false,
      transcript: '',
      role: 'user',
    },
    setVoiceState: (updates) => set((state) => ({ voiceState: { ...state.voiceState, ...updates } })),
    streams: {},
    appendStream: (agentId, token) => {
      set((state) => {
        const currentStream = state.streams[agentId] || '';
        const newStream = currentStream + token;
        const updatedAgents = state.agents.map(a =>
          a.id === agentId ? { ...a, tasks: [newStream.split('\n').pop()?.substring(0, 100) || ''] } : a
        );
        // Also surface to CORE OUTPUT
        const lastLine = newStream.split('\n').pop() || '';
        const newLogs = lastLine.length % 80 === 0
          ? [...state.logs.slice(-200), `[${agentId.toUpperCase()}] ${lastLine.slice(-80)}`]
          : state.logs;
        return { streams: { ...state.streams, [agentId]: newStream }, agents: updatedAgents, logs: newLogs };
      });
    },
    sendCommand: (cmd) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'command', text: cmd, model: get().aiModel }));
    },
    toggleMic: () => {
      const nextState = !get().voiceState.isListening;
      set((state) => ({ voiceState: { ...state.voiceState, isListening: nextState, transcript: '' } }));
      if (nextState) startAudioCapture();
      else {
        if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
        if (source) { source.disconnect(); source = null; }
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mic_toggle', active: nextState }));
      }
    },
    feed: [],
    notifications: [],
    addNotification: (n) => set((state) => ({
      notifications: [
        { ...n, id: crypto.randomUUID(), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) },
        ...state.notifications,
      ].slice(0, 20),
    })),
    telemetry: { cpu: 0, ram: 0 },
    crypto: null,
    health: { connected: false },
    spotify: { state: 'stopped', track: '', artist: '' },
    spotifyAction: async (action: string, value?: number) => {
      try {
        const res = await fetch(`${BACKEND_HTTP}/api/spotify/${action}?api_key=${encodeURIComponent(API_KEY)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        const data = await res.json();
        if (data.state !== undefined) set({ spotify: data });
      } catch(e) {}
    },
    quickAction: async (name: string) => {
      if (name === 'wipe-terminal') { get().clearLogs(); return; }
      if (name === 'download-logs') {
        window.open(`${BACKEND_HTTP}/api/action/download-logs?api_key=${encodeURIComponent(API_KEY)}`, '_blank');
        return;
      }
      try {
        await fetch(`${BACKEND_HTTP}/api/action/${name}?api_key=${encodeURIComponent(API_KEY)}`, { method: 'POST' });
      } catch(e) {}
    },
    activeAgentConnections: [],
    agentOutcome: null,
    dismissOutcome: () => {
      set({ agentOutcome: null });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop_tts' }));
      }
      audioQueue.length = 0;
    },
    settingsOpen: false,
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    hostUrl: defaultHost(),
    apiKey: ENV_API_KEY,
    activeServerUrl: '',
    activeServerName: '',
    serverError: null,
    wsConnected: false,
    appLanguage: 'en',
    ttsServer: '',
    cryptoWallet: '',
    newsRssUrl: '',
    avatarGender: 'female',
    setAvatarGender: (gender) => set({ avatarGender: gender }),
    avatarId: DEFAULT_AVATAR,
    setAvatarId: (id) => set({ avatarId: id }),
    avatarBackgroundId: 'plain_white',
    setAvatarBackgroundId: (id) => set({ avatarBackgroundId: id }),
    avatarPrompt: 'You are Jarvis, the central AI orchestrator for this machine, equipped with autonomous sub-agents: Antigravity (AGY), Claude, and Hermes. When asked to perform any computer task, coding, browsing, terminal or file action, ALWAYS delegate to AGY, Claude, or Hermes using your tools.',
    setAvatarPrompt: (prompt) => set({ avatarPrompt: prompt }),
    avatarServerUrl: '',
    setAvatarServerUrl: (url) => set({ avatarServerUrl: url }),
    avatarVoice: 'Kore',
    setAvatarVoice: (voice) => set({ avatarVoice: voice }),
    avatarTrainingJobs: {},
    setAvatarTrainingJob: (job) => set((state) => ({
      avatarTrainingJobs: { ...state.avatarTrainingJobs, [job.avatarId]: job }
    })),
    removeAvatarTrainingJob: (avatarId) => set((state) => {
      const next = { ...state.avatarTrainingJobs };
      delete next[avatarId];
      return { avatarTrainingJobs: next };
    }),
    loadSettings: async () => {
      try {
        const data = localStorage.getItem('JARVIS_SETTINGS');
        if (data) {
          const parsed = JSON.parse(data);
          const loadedHost = normalizeHost(parsed.hostUrl || defaultHost());
          const loadedKey = parsed.apiKey || ENV_API_KEY;
          set({
            hostUrl: loadedHost,
            apiKey: loadedKey,
            appLanguage: parsed.appLanguage || 'en',
            ttsServer: parsed.ttsServer || '',
            cryptoWallet: parsed.cryptoWallet || '',
            newsRssUrl: parsed.newsRssUrl || '',
            avatarGender: parsed.avatarGender || 'female',
            avatarId: parsed.avatarId || DEFAULT_AVATAR,
            avatarBackgroundId: parsed.avatarBackgroundId || 'plain_white',
            avatarPrompt: (parsed.avatarPrompt && (parsed.avatarPrompt.includes('delegate') || parsed.avatarPrompt.includes('AGY'))) ? parsed.avatarPrompt : 'You are Jarvis, the central AI orchestrator for this machine, equipped with autonomous sub-agents: Antigravity (AGY), Claude, and Hermes. When asked to perform any computer task, coding, browsing, terminal or file action, ALWAYS delegate to AGY, Claude, or Hermes using your tools.',
            avatarVoice: parsed.avatarVoice || 'Kore'
          });
        }
      } catch (e) {}
    },
    updateSettings: async (settings) => {
      const serverChanged = (['hostUrl', 'apiKey'] as const)
        .some((k) => settings[k] !== undefined && settings[k] !== get()[k]);
      set((state) => {
        // The avatar always runs on the connected server (set on connect), never a separate one.
        const { avatarServerUrl: _ignored, ...rest } = settings;
        const next = { ...state, ...rest };
        localStorage.setItem('JARVIS_SETTINGS', JSON.stringify({
          hostUrl: next.hostUrl,
          apiKey: next.apiKey,
          appLanguage: next.appLanguage,
          ttsServer: next.ttsServer,
          cryptoWallet: next.cryptoWallet,
          newsRssUrl: next.newsRssUrl,
          avatarGender: next.avatarGender,
          avatarId: next.avatarId,
          avatarBackgroundId: next.avatarBackgroundId,
          avatarPrompt: next.avatarPrompt,
          avatarVoice: next.avatarVoice,
        }));
        return next;
      });
      // A different server or key: drop the current one and connect again.
      if (serverChanged) {
        dropServer();
        connectWS();
        return;
      }
      // Preferences only — never the keys or which server to use.
      const { apiKey: _k, hostUrl: _h, ...prefs } = settings;
      if (!BACKEND_HTTP) return;
      try {
        await fetch(`${BACKEND_HTTP}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify(prefs)
        });
      } catch (e) {}
    }
  };
});
