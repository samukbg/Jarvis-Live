import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { 
  X, Upload, Mic, MicOff, Play, Pause, CheckCircle2, 
  AlertCircle, Sparkles, Image as ImageIcon, Volume2, Loader2
} from 'lucide-react';
import { useStore, BACKEND_HTTP, API_KEY } from '../store';

interface CreateAvatarModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAvatarCreated?: (avatarId: string) => void;
}

const GEMINI_VOICES = [
  { id: 'Kore', label: 'Kore (Calm, melodic female)', gender: 'female' },
  { id: 'Aoede', label: 'Aoede (Expressive, warm female)', gender: 'female' },
  { id: 'Puck', label: 'Puck (Engaging, articulate male)', gender: 'male' },
  { id: 'Charon', label: 'Charon (Deep, resonant male)', gender: 'male' },
  { id: 'Fenrir', label: 'Fenrir (Direct, authoritative male)', gender: 'male' }
];

export const CreateAvatarModal: React.FC<CreateAvatarModalProps> = ({ isOpen, onClose, onAvatarCreated }) => {
  const { activeServerUrl, setAvatarId, setAvatarVoice, setAvatarGender, addNotification, avatarTrainingJobs, setAvatarTrainingJob } = useStore();

  const [name, setName] = useState('');
  const [gender, setGender] = useState<'female' | 'male'>('female');
  const [voice, setVoice] = useState('Kore');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdAvatarId, setCreatedAvatarId] = useState<string | null>(null);
  const [submitStep, setSubmitStep] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [existingAvatars, setExistingAvatars] = useState<string[]>([
    'maria', 'ben', 'kate', 'john', 'oliver', 'clara', 'ming',
    'elena', 'jack', 'may', 'arnold', 'camila', 'caroline', 'gordon', 'marcus', 'mozart', 'trevor'
  ]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<any>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  // Stabilize callbacks with refs to avoid re-triggering effects
  const onAvatarCreatedRef = useRef(onAvatarCreated);
  onAvatarCreatedRef.current = onAvatarCreated;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handledReadyRef = useRef<string | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen && !isSubmitting) {
      setName('');
      setImagePreview(null);
      setImageBase64(null);
      setAudioBase64(null);
      setAudioUrl(null);
      setErrorMsg(null);
      setSubmitStep('');
      setCreatedAvatarId(null);
      handledReadyRef.current = null;
    }
  }, [isOpen]);

  // Fetch live existing avatars to guarantee no currently added avatar can be overwritten
  useEffect(() => {
    if (!isOpen) return;
    const fetchExisting = async () => {
      const base = activeServerUrl || BACKEND_HTTP;
      if (!base) return;
      try {
        const res = await fetch(`${base}/api/avatar/avatars`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.avatars) && data.avatars.length > 0) {
            setExistingAvatars(data.avatars.map((a: string) => a.toLowerCase()));
          }
        }
      } catch (e) {}
    };
    fetchExisting();
  }, [isOpen, activeServerUrl]);

  const currentJob = createdAvatarId ? avatarTrainingJobs?.[createdAvatarId] : null;
  const currentProgress = currentJob?.progress ?? (isSubmitting ? 20 : 0);
  const currentStep = currentJob?.step || submitStep || 'Preparing GPU models...';
  const currentJobStatus = currentJob?.status;

  // Listen for background training updates for the newly submitted avatar
  useEffect(() => {
    if (!createdAvatarId) return;
    if (currentJobStatus === 'ready' && handledReadyRef.current !== createdAvatarId) {
      handledReadyRef.current = createdAvatarId;
      setSubmitStep('Neural voice clone & avatar active in RTX 3090 VRAM!');
      setAvatarId(createdAvatarId);
      setAvatarVoice(voice);
      setAvatarGender(gender);
      onAvatarCreatedRef.current?.(createdAvatarId);
      const timer = setTimeout(() => {
        setIsSubmitting(false);
        setCreatedAvatarId(null);
        handledReadyRef.current = null;
        onCloseRef.current?.();
      }, 1500);
      return () => clearTimeout(timer);
    } else if (currentJobStatus === 'failed') {
      setErrorMsg(currentJob?.error || 'Avatar training failed on GPU');
      setIsSubmitting(false);
      setCreatedAvatarId(null);
    }
  }, [createdAvatarId, currentJobStatus, voice, gender, setAvatarId, setAvatarVoice, setAvatarGender]);

  // Handle image upload
  const handleImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please select a valid image file (PNG, JPEG, WEBP)');
      return;
    }
    setErrorMsg(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const res = e.target?.result as string;
      setImagePreview(res);
      setImageBase64(res);
    };
    reader.readAsDataURL(file);
  };

  // Handle audio upload
  const handleAudioFile = (file: File) => {
    if (!file.type.startsWith('audio/') && !file.name.match(/\.(ogg|wav|mp3|m4a|aac)$/i)) {
      setErrorMsg('Please select a valid audio file (.wav, .ogg, .mp3, .m4a)');
      return;
    }
    setErrorMsg(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const res = e.target?.result as string;
      setAudioBase64(res);
      setAudioUrl(res);
    };
    reader.readAsDataURL(file);
  };

  // Start live microphone recording for voice cloning sample
  const startRecording = async () => {
    try {
      setErrorMsg(null);
      audioChunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        const url = URL.createObjectURL(audioBlob);
        setAudioUrl(url);

        const reader = new FileReader();
        reader.onloadend = () => {
          setAudioBase64(reader.result as string);
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(t => t.stop());
      };

      recorder.start(100);
      setIsRecording(true);
      setRecordingDuration(0);

      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(prev => {
          if (prev >= 30) {
            stopRecording();
            return 30;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err: any) {
      setErrorMsg('Microphone access denied: ' + (err.message || String(err)));
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    }
  };

  const toggleAudioPlayback = () => {
    if (!audioPlayerRef.current || !audioUrl) return;
    if (isPlayingAudio) {
      audioPlayerRef.current.pause();
      setIsPlayingAudio(false);
    } else {
      audioPlayerRef.current.play();
      setIsPlayingAudio(true);
    }
  };

  // Submit avatar
  const handleSubmit = async () => {
    if (!name.trim()) {
      setErrorMsg('Please give your avatar a name');
      return;
    }
    const cleanId = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (existingAvatars.includes(cleanId)) {
      setErrorMsg(`An avatar named "${name}" (ID: "${cleanId}") already exists. Please choose a unique name to avoid replacing any existing avatar.`);
      return;
    }
    if (!imageBase64) {
      setErrorMsg('Please upload an avatar portrait photo following the guide');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSubmitStep('Initiating avatar generation on RTX 3090 GPU...');

    const base = activeServerUrl || BACKEND_HTTP;

    try {
      if (!base) throw new Error('Not connected to a Jarvis server yet');
      const response = await fetch(`${base}/api/avatar/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          name: name.trim(),
          image: imageBase64,
          audio: audioBase64 || undefined,
          gender,
          voice,
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server responded with ${response.status}`);
      }

      const data = await response.json();
      const newAvatarId = data.avatarId || cleanId;
      setCreatedAvatarId(newAvatarId);

      if (data.job) {
        setAvatarTrainingJob(data.job);
      }

      addNotification({
        label: 'AVATAR TRAINING',
        msg: `Generating avatar "${name}" in background on RTX 3090 GPU...`,
        kind: 'info'
      });

    } catch (err: any) {
      console.error('Failed to create avatar:', err);
      setErrorMsg(err.message || 'Failed to create avatar');
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div 
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl bg-[#060d17]/95 border border-accent-cyan/30 rounded-2xl shadow-2xl overflow-hidden p-6 text-white my-8 max-h-[90vh] overflow-y-auto scrollbar-thin"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between pb-4 border-b border-accent-cyan/20">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-accent-cyan/10 border border-accent-cyan/30 text-accent-cyan">
              <Sparkles size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-wide text-white">Create New Live Avatar</h2>
              <p className="text-xs text-white/50">Upload a portrait photo & clone a custom neural voice</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 text-white/50 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {errorMsg && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs flex items-center gap-2">
            <AlertCircle size={16} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="mt-5 space-y-6">
          {/* ── 1. Avatar Identity & Name ─────────────────────────────────── */}
          <div className="p-4 bg-white/[0.03] border border-white/10 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-bold tracking-wide text-accent-cyan">
                1. Avatar Name & Persona
              </label>
              {name.trim() && (
                existingAvatars.includes(name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '')) ? (
                  <span className="text-[10px] text-amber-400 font-bold flex items-center gap-1">
                    <AlertCircle size={11} /> Name already in use
                  </span>
                ) : (
                  <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                    ✓ Available: ID "{name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '')}"
                  </span>
                )
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-[11px] font-semibold text-white/70 mb-1">
                  Avatar Name (e.g. Sophia, Marcus)
                </label>
                <input 
                  type="text" 
                  value={name} 
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sophia"
                  className="w-full px-3 py-2 bg-black/40 border border-white/20 rounded-xl text-sm text-white placeholder-white/30 focus:border-accent-cyan focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-white/70 mb-1">
                  Gender
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setGender('female')}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
                      gender === 'female'
                        ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan'
                        : 'bg-white/5 border-white/10 text-white/60 hover:text-white'
                    }`}
                  >
                    Female
                  </button>
                  <button
                    type="button"
                    onClick={() => setGender('male')}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
                      gender === 'male'
                        ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan'
                        : 'bg-white/5 border-white/10 text-white/60 hover:text-white'
                    }`}
                  >
                    Male
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-white/70 mb-1">
                  Base Gemini Live Voice
                </label>
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  className="w-full px-3 py-2 bg-black/40 border border-white/20 rounded-xl text-sm text-white focus:border-accent-cyan focus:outline-none"
                >
                  {GEMINI_VOICES.map(v => (
                    <option key={v.id} value={v.id} className="bg-black text-white">
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* ── 2. Avatar Photo Section & Visual Mockup Guide ─────────────── */}
          <div>
            <label className="block text-xs font-bold tracking-wide text-accent-cyan mb-2">
              2. Avatar Portrait Photo (Head & Shoulders)
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Photo Upload / Preview Zone (16:9 Widescreen Stream Format) */}
              <div 
                onClick={() => fileInputRef.current?.click()}
                className={`relative aspect-video rounded-xl border-2 border-dashed transition-all flex flex-col items-center justify-center cursor-pointer overflow-hidden group ${
                  imagePreview 
                    ? 'border-accent-cyan/60 bg-black' 
                    : 'border-white/20 hover:border-accent-cyan/40 bg-white/5'
                }`}
              >
                {imagePreview ? (
                  <>
                    {/* Blurred ambient backdrop for proportional framing */}
                    <div 
                      className="absolute inset-0 bg-cover bg-center blur-md opacity-40 scale-110"
                      style={{ backgroundImage: `url(${imagePreview})` }}
                    />
                    {/* Proportional face/shoulders without distortion */}
                    <img src={imagePreview} alt="Avatar Preview" className="relative z-10 h-full w-auto max-w-full object-contain mx-auto" />
                    <div className="absolute top-2 right-2 z-20 px-2 py-0.5 rounded bg-black/70 border border-white/20 text-[9px] text-accent-cyan">
                      16:9 STREAM PREVIEW
                    </div>
                    <div className="absolute inset-0 z-30 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-xs text-white gap-1">
                      <Upload size={20} className="text-accent-cyan" />
                      <span>Click to replace image</span>
                    </div>
                  </>
                ) : (
                  <div className="p-4 text-center">
                    <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-accent-cyan/10 border border-accent-cyan/30 flex items-center justify-center text-accent-cyan">
                      <ImageIcon size={24} />
                    </div>
                    <p className="text-xs font-semibold text-white">Click to upload photo</p>
                    <p className="text-[10px] text-white/40 mt-1">16:9 landscape or portrait (auto-fitted)</p>
                  </div>
                )}
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  accept="image/png,image/jpeg,image/webp" 
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImageFile(file);
                  }}
                />
              </div>

              {/* Photo Mockup & Guidelines Card */}
              <div className="p-4 bg-white/[0.03] border border-white/10 rounded-xl flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-accent-cyan/20 text-accent-cyan">
                      PHOTO MOCKUP GUIDE
                    </span>
                  </div>

                  {/* Visual Silhouette Mockup Diagram */}
                  <div className="relative w-full h-28 bg-[#060d17]/80 rounded-lg border border-accent-cyan/20 flex items-center justify-center overflow-hidden mb-3">
                    <svg viewBox="0 0 100 120" className="h-full w-auto text-accent-cyan/40">
                      {/* Head & shoulders silhouette */}
                      <circle cx="50" cy="40" r="22" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
                      {/* Eye line */}
                      <line x1="32" y1="38" x2="68" y2="38" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" className="text-accent-cyan" />
                      {/* Face oval target */}
                      <ellipse cx="50" cy="42" rx="15" ry="18" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent-cyan" />
                      {/* Shoulders */}
                      <path d="M 12 110 Q 50 70 88 110" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                    <span className="absolute bottom-1 right-2 text-[9px] text-accent-cyan/60">
                      IDEAL FRAMING
                    </span>
                  </div>

                  <ul className="space-y-1.5 text-[11px] text-white/70">
                    <li className="flex items-start gap-1.5">
                      <CheckCircle2 size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                      <span>Front-facing, eye contact with camera</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <CheckCircle2 size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                      <span>Head and shoulders fully visible</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <CheckCircle2 size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                      <span>Neutral expression & clean lighting</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <AlertCircle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                      <span>No profile angles, sunglasses, or blur</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* ── 2. Voice Cloning Audio Sample Section ────────────────────── */}
          <div>
            <label className="block text-xs font-bold tracking-wide text-accent-cyan mb-2">
              2. Voice Cloning Sample (Audio)
            </label>

            <div className="p-4 bg-white/[0.03] border border-white/10 rounded-xl space-y-3">
              <p className="text-xs text-white/60">
                Upload a 5–30s clean audio sample of the person talking, or record live using your microphone:
              </p>

              <div className="flex flex-wrap items-center gap-3">
                {/* Record Mic Button */}
                <button
                  type="button"
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                    isRecording 
                      ? 'bg-red-500 text-white animate-pulse' 
                      : 'bg-white/10 hover:bg-white/20 text-white border border-white/20'
                  }`}
                >
                  {isRecording ? <MicOff size={15} /> : <Mic size={15} />}
                  <span>{isRecording ? `Recording... (${recordingDuration}s)` : 'Record Mic'}</span>
                </button>

                {/* Upload Audio File */}
                <button
                  type="button"
                  onClick={() => audioInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white border border-white/20 rounded-xl text-xs font-bold transition-all"
                >
                  <Volume2 size={15} />
                  <span>Upload Audio File (.wav, .ogg, .mp3)</span>
                </button>

                <input 
                  type="file" 
                  ref={audioInputRef} 
                  accept="audio/wav,audio/ogg,audio/mpeg,audio/mp4,audio/x-m4a,.wav,.ogg,.mp3,.m4a" 
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleAudioFile(file);
                  }}
                />

                {/* Audio Preview & Playback */}
                {audioUrl && (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-accent-cyan/10 border border-accent-cyan/30 rounded-xl">
                    <button
                      type="button"
                      onClick={toggleAudioPlayback}
                      className="p-1 rounded-full bg-accent-cyan text-black hover:opacity-90 transition-opacity"
                    >
                      {isPlayingAudio ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                    <span className="text-xs text-accent-cyan">Voice sample ready</span>
                    <audio 
                      ref={audioPlayerRef} 
                      src={audioUrl} 
                      onEnded={() => setIsPlayingAudio(false)} 
                      className="hidden" 
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Async Processing / Training Progress Bar */}
        {isSubmitting && (
          <div className="mt-4 p-4 rounded-xl bg-black/60 border border-accent-cyan/40 backdrop-blur-md">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="flex items-center gap-2 font-bold text-accent-cyan">
                {currentJob?.status === 'ready' ? (
                  <CheckCircle2 size={15} className="text-emerald-400" />
                ) : currentJob?.status === 'failed' ? (
                  <AlertCircle size={15} className="text-rose-400" />
                ) : (
                  <Loader2 size={15} className="animate-spin text-accent-cyan" />
                )}
                {currentJob?.status === 'ready' 
                  ? 'GENERATION COMPLETE' 
                  : currentJob?.status === 'failed' 
                    ? 'GENERATION FAILED' 
                    : 'TRAINING AVATAR ON RTX 3090 GPU'}
              </span>
              <span className="font-bold text-white">{currentProgress}%</span>
            </div>

            {/* Glowing progress track */}
            <div className="w-full h-2.5 bg-white/10 rounded-full overflow-hidden border border-accent-cyan/30 p-[1px]">
              <div 
                className={`h-full transition-all duration-500 rounded-full ${
                  currentJob?.status === 'failed' 
                    ? 'bg-rose-500' 
                    : currentJob?.status === 'ready' 
                      ? 'bg-emerald-400' 
                      : 'bg-gradient-to-r from-accent-cyan via-teal-400 to-emerald-400 shadow-[0_0_12px_rgba(0,240,255,0.8)]'
                }`}
                style={{ width: `${currentProgress}%` }}
              />
            </div>

            <div className="flex items-center justify-between mt-2 text-[11px] text-white/70">
              <span className="truncate max-w-[80%]">{currentStep}</span>
              <span className="text-[10px] text-accent-cyan/70 font-bold">ASYNC PIPELINE</span>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="mt-6 pt-4 border-t border-accent-cyan/20 flex items-center justify-between">
          <div className="text-xs text-white/50">
            {isSubmitting ? (
              <span className="text-accent-cyan/80">
                You can close this modal; generation will continue in the background.
              </span>
            ) : (
              <span>Photo + audio automatically loaded into AVTR-1 GPU memory</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-bold text-white/60 hover:text-white hover:bg-white/10 transition-all"
            >
              {isSubmitting ? 'Continue in Background' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-bold bg-accent-cyan hover:bg-accent-cyan/90 text-black shadow-lg shadow-accent-cyan/20 transition-all disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              <span>{isSubmitting ? 'Generating...' : 'Create Live Avatar'}</span>
            </button>
          </div>
        </div>
      </motion.div>
    </div>,
    document.body
  );
};
