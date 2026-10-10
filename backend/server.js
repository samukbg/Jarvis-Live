import dotenv from 'dotenv';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// No API_KEY in .env: generate one for this run (never fall back to a well-known default).
if (!process.env.API_KEY) {
  process.env.API_KEY = randomBytes(24).toString('hex');
  console.warn(`[security] No API_KEY in .env — generated one for this run: ${process.env.API_KEY}\n           Put API_KEY=… in .env to keep it across restarts.`);
}
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import http from 'http';
import fetch from 'node-fetch';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import si from 'systeminformation';
import RSSParser from 'rss-parser';
import { ConversationMemory } from './shared/memory/ConversationMemory.js';
import { TTSEngine } from './tts/TTSEngine.js';
import { STTProxy } from './stt/STTProxy.js';
import { AgyWorker } from './hermes/workers/AgyWorker.js';
import { ClaudeWorker } from './hermes/workers/ClaudeWorker.js';
import { getCrossPlatformEnv, getCrossPlatformCommand, getSpawnOptions, escapeArg, shellArg } from './shared/osUtils.js';
import { HermesCLIWorker } from './hermes/workers/HermesCLIWorker.js';
import { HermesRuntime } from './hermes/HermesRuntime.js';
import { WorkerRegistry } from './hermes/WorkerRegistry.js';
import { CapabilityRegistry } from './hermes/CapabilityRegistry.js';
import { ConversationRuntime } from './conversation/ConversationRuntime.js';
import { registerCardRoutes } from './cards/index.js';
import { GeminiLiveProvider } from './conversation/providers/GeminiLiveProvider.js';
import { PhoneBridge, PHONE_ACTION_PROMPT, PHONE_ACTION_TOOL } from './device/phoneActions.js';
import { isAuthorized } from './shared/auth.js';
import { callbackUrl, createAvatarSource, lanAddress } from './avatar/avatarSource.js';
import { createStatusCollector } from './system/serverStatus.js';
import { createAgentDetector } from './agents/detect.js';
import { UtteranceJoiner } from './avatar/utteranceJoiner.js';
import { acknowledgement } from './conversation/acknowledge.js';
import { agyModelArgs } from './agents/agyModel.js';
import { wslDistro, wslRoots } from './system/wslDistro.js';
import { pickAvatar } from './avatar/pickAvatar.js';
import { splitHermesModel } from './agents/hermesModel.js';
import { GoogleGenAI, Modality } from '@google/genai';


// Removed hardcoded small talk JSON load

const execAsync = promisify(exec);
const app = express();
const port = process.env.PORT || 4000;

// Enable CORS and JSON body parser FIRST for all routes
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.resolve(__dirname, '../public')));

// Security layer: the owner's API_KEY (shared/auth.js).
// Public: static assets, the avatar/background list, ICE servers, models/agents discovery and
// the server status. Starting avatar sessions needs the key: an open /offer would let anyone
// on the network take the GPU.
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/local-image') ||
    req.path.startsWith('/api/avatar/avatars') ||
    req.path.startsWith('/avatars') ||
    req.path.startsWith('/ice-servers') ||
    req.path.startsWith('/api/models') ||
    req.path.startsWith('/api/agents') ||
    req.path === '/api/server/status' ||
    (req.method === 'GET' && req.path.startsWith('/api/settings')) ||
    req.path === '/' ||
    req.path.startsWith('/assets')
  ) {
    return next();
  }
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!isAuthorized(key, process.env, req.path)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API_KEY' });
  }
  next();
});

// ── Live Avatar Integration & Proxy (AVTR-1) ─────────────────────────
let audioSeqOut = 0;
function broadcastAudioChunk(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length === 0) return;
  const header = Buffer.alloc(12);
  header.write('AUDO', 0, 4, 'ascii');
  header.writeUInt32BE(audioSeqOut++, 4);
  header.writeUInt32BE(Date.now() & 0xFFFFFFFF, 8);
  const binaryPacket = Buffer.concat([header, pcmBuffer]);
  voiceTargets().forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(binaryPacket);
    }
  });
}

let videoSeqOut = 0;
function broadcastVideoFrame(frameBuffer) {
  if (!frameBuffer || frameBuffer.length === 0) return;
  const header = Buffer.alloc(12);
  header.write('VIDO', 0, 4, 'ascii');
  header.writeUInt32BE(videoSeqOut++, 4);
  header.writeUInt32BE(Date.now() & 0xFFFFFFFF, 8);
  const binaryPacket = Buffer.concat([header, frameBuffer]);
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(binaryPacket);
    }
  });
}

const DEFAULT_AVATARS_LIST = [
  'maria', 'kate', 'clara', 'elena', 'may', 'camila', 'caroline',
  'ben', 'john', 'oliver', 'ming', 'jack', 'arnold', 'gordon', 'marcus', 'mozart', 'trevor'
];
const DEFAULT_BACKGROUNDS_LIST = [
  'plain_white', 'study_desk', 'bright_loft', 'minimal_office',
  'aloe_window', 'beige_sofa', 'framed_art', 'jungle_window',
  'lounge_chairs', 'sunlit_bedroom'
];
const AVATAR_TRAINING_JOBS = new Map();

function broadcastAvatarTraining(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(msg);
    }
  });
}

const SERVER_VERSION = process.env.JARVIS_VERSION || (() => { try { return execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } })();

// ── Dynamic Live Avatar Streamer & Renderer Discovery ───────────────────────────
let configuredStreamerUrl = (process.env.STREAMER_URL || process.env.LIVE_AVATAR_URL || process.env.AVATAR_SERVER_URL || '').trim();
global.AVATAR_SERVER_URL = configuredStreamerUrl;

// Settings → Live avatar → Avatar server: your own AVTR-1 server, else the default above
// (avatar/avatarSource.js; saved in the data folder).
const avatarSource = createAvatarSource({ file: path.join(process.env.JARVIS_DATA_DIR || path.resolve(__dirname, '..'), 'avatar-source.json') });
const ownAvatarServer = () => { const s = avatarSource.get(); return s.mode === 'own' ? s : null; };

function getStreamerCandidateUrls(reqHost = '') {
  const own = ownAvatarServer();
  if (own) return [own.url];
  const candidates = [];
  const hostLower = String(reqHost || '').toLowerCase();

  // 1. Native local streamer on port 7860 MUST ALWAYS BE FIRST (local process)
  candidates.push('http://127.0.0.1:7860');
  candidates.push('http://localhost:7860');

  // 2. Custom streamer URL if configured AND not pointing to self
  for (const u of [global.AVATAR_SERVER_URL, configuredStreamerUrl]) {
    if (u) {
      const clean = u.replace(/\/+$/, '');
      const uLower = clean.toLowerCase();
      // Guard: NEVER proxy to self (causes fatal recursive loop through Cloudflare!)
      if (
        !uLower.includes('localhost:4000') &&
        !uLower.includes('127.0.0.1:4000') &&
        (!hostLower || !uLower.includes(hostLower))
      ) {
        candidates.push(clean);
      }
    }
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

async function fetchFromStreamer(endpointPath, options = {}, reqHost = '') {
  const candidates = getStreamerCandidateUrls(reqHost);
  const own = ownAvatarServer();
  let lastError = null;

  for (const base of candidates) {
    const targetUrl = `${base}${endpointPath}`;
    try {
      const resp = await fetch(targetUrl, {
        ...options,
        // Your own avatar server, when it's another Jarvis server: its API key.
        headers: own?.key && base === own.url ? { ...(options.headers || {}), 'x-api-key': own.key } : options.headers,
        signal: options.signal || AbortSignal.timeout(12000)
      });
      return resp;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to reach any Live Avatar streamer (tried: ${candidates.join(', ')})`);
}

app.get(['/avatars', '/avatars/', '/api/avatar/avatars', '/api/avatar/avatars/'], async (req, res) => {
  let avatars = DEFAULT_AVATARS_LIST;
  let backgrounds = DEFAULT_BACKGROUNDS_LIST;
  try {
    const fetchRes = await fetchFromStreamer('/avatars', { signal: AbortSignal.timeout(4000) }, req.get('host'));
    if (fetchRes.ok) {
      const data = await fetchRes.json();
      if (Array.isArray(data.avatars) && data.avatars.length > 0) avatars = data.avatars;
      if (Array.isArray(data.backgrounds) && data.backgrounds.length > 0) backgrounds = data.backgrounds;
    }
  } catch (e) {}

  const training = Array.from(AVATAR_TRAINING_JOBS.values()).filter(j => j.status === 'training');
  return res.json({
    avatars,
    backgrounds,
    training
  });
});

app.get(['/api/avatar/training-status', '/api/avatar/training-status/'], (req, res) => {
  return res.json({
    training: Array.from(AVATAR_TRAINING_JOBS.values())
  });
});

app.get(['/ice-servers', '/api/avatar/ice-servers', '/api/avatar/ice-servers/'], async (req, res) => {
  try {
    const fetchRes = await fetchFromStreamer('/ice-servers', { signal: AbortSignal.timeout(4000) }, req.get('host'));
    if (fetchRes.ok) {
      const data = await fetchRes.json();
      return res.json(data);
    }
  } catch (e) {}
  res.json({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], iceTransportPolicy: 'all' });
});

// Latency probe: streamer + renderer timings and mobile WebRTC stats (see docs/superpowers/specs/2026-09-28-avatar-latency-design.md)
app.get(['/api/avatar/debug/latency', '/api/avatar/debug/latency/'], async (req, res) => {
  try {
    const response = await fetchFromStreamer('/debug/latency', { signal: AbortSignal.timeout(6000) }, req.get('host'));
    return res.status(response.status).json(await response.json());
  } catch (err) {
    return res.status(503).json({ error: 'Failed to reach Live Avatar streamer: ' + (err.message || String(err)) });
  }
});

app.post(['/api/avatar/debug/latency/reset', '/api/avatar/client-stats'], async (req, res) => {
  const streamerPath = req.path.endsWith('/client-stats') ? '/client-stats' : '/debug/latency/reset';
  try {
    const response = await fetchFromStreamer(streamerPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(6000),
    }, req.get('host'));
    return res.status(response.status).json(await response.json());
  } catch (err) {
    return res.status(503).json({ error: 'Failed to reach Live Avatar streamer: ' + (err.message || String(err)) });
  }
});

// What the streamer sent to Gemini Live in the last minute (diagnosing mis-heard speech).
app.get(['/api/avatar/debug/input', '/api/avatar/debug/input.wav'], async (req, res) => {
  try {
    const r = await fetchFromStreamer(req.path.endsWith('.wav') ? '/debug/input.wav' : '/debug/input', { signal: AbortSignal.timeout(15000) }, req.get('host'));
    res.status(r.status).set('Content-Type', r.headers.get('content-type') || 'application/octet-stream').send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.status(503).json({ error: 'Failed to reach Live Avatar streamer: ' + (err.message || String(err)) });
  }
});

// Frames from the iOS screen-broadcast extension (works while the app is in the background).
app.post('/api/vision/frame', (req, res) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!isAuthorized(key)) return res.status(401).json({ error: 'Unauthorized' });
  const { mimeType, data } = req.body || {};
  if (!data || !String(mimeType || 'image/jpeg').startsWith('image/')) return res.status(400).json({ error: 'image frame required' });
  routeVisionFrame(mimeType, data, req.get('host'));
  res.json({ ok: true, target: avatarModeActive ? 'avatar' : 'live' });
});

app.post(['/probe-offer', '/api/avatar/probe-offer', '/api/avatar/probe-offer/'], async (req, res) => {
  try {
    const response = await fetchFromStreamer('/probe-offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    }, req.get('host'));
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(503).json({ error: 'Failed to probe WebRTC offer: ' + (err.message || String(err)) });
  }
});

/**
 * Where the streamer calls this backend back (delegation, transcripts, phone actions) —
 * with this server's API_KEY. Only the owner may choose it: anyone else could point it at
 * their own host and collect the key.
 */
/** pinBackendUrl, except with your own avatar server: it calls this server back with its key. */
function pinCallback(engine, req) {
  const own = ownAvatarServer();
  if (!own || !engine) return pinBackendUrl(engine, req);
  const url = callbackUrl({ target: own.url, port, lan: lanAddress(), tunnelUrl: null, envUrl: process.env.JARVIS_BACKEND_URL });
  if (url) Object.assign(engine, { jarvis_backend_url: url, jarvis_backend_key: process.env.API_KEY });
}

function pinBackendUrl(engine, req) {
  if (!engine) return;
  const isOwner = (req.headers['x-api-key'] || req.query.api_key) === process.env.API_KEY;
  delete engine.jarvis_backend_key;
  if (isOwner && engine.jarvis_backend_url) return;
  if (isOwner) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || `127.0.0.1:${port}`;
    engine.jarvis_backend_url = process.env.JARVIS_BACKEND_URL || `${proto}://${host}`;
  } else {
    engine.jarvis_backend_url = process.env.JARVIS_BACKEND_URL || `http://127.0.0.1:${port}`;
  }
}

// Avatars this server's renderer really has (null when it can't be asked), cached briefly.
let rendererAvatarsCache = { at: 0, list: null };
async function rendererAvatars(host) {
  if (Date.now() - rendererAvatarsCache.at < 30_000) return rendererAvatarsCache.list;
  let list = null;
  try {
    const r = await fetchFromStreamer('/avatars', { signal: AbortSignal.timeout(4000) }, host);
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d.avatars) && d.avatars.length) list = d.avatars;
    }
  } catch {}
  rendererAvatarsCache = { at: Date.now(), list };
  return list;
}

/** Point a session at an avatar this renderer has (see avatar/pickAvatar.js). */
async function useAvailableAvatar(body, req) {
  const requested = body.avatar_id || body.engine?.avatar_id;
  const avatar = pickAvatar(requested, await rendererAvatars(req.get('host')));
  if (requested && avatar !== String(requested).toLowerCase()) {
    broadcastLog(`[LIVE AVATAR] "${requested}" isn't on this server — using "${avatar}".`);
  }
  body.avatar_id = avatar;
  if (body.engine) body.engine.avatar_id = avatar;
  return avatar;
}

/** A streamer reply as JSON, even when it answered plain text ("Internal Server Error"). */
async function streamerJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 500) || `HTTP ${response.status}` }; }
}

app.post(['/offer', '/api/avatar/offer', '/api/avatar/offer/'], async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.engine && (!payload.engine.api_key || payload.engine.api_key === 'SERVER_MANAGED')) {
      payload.engine.api_key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    }
    if (payload.engine) payload.engine = { ...payload.engine };
    pinCallback(payload.engine, req);
    const avatar = await useAvailableAvatar(payload, req);
    const response = await fetchFromStreamer('/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, req.get('host'));
    const data = await streamerJson(response);
    res.set('X-Avatar-Id', avatar);
    // 502/504 from here would be replaced by Cloudflare's error page: say 503 instead.
    return res.status([502, 504].includes(response.status) ? 503 : response.status).json(data);
  } catch (err) {
    console.error('[LiveAvatar] Streamer proxy error:', err);
    return res.status(503).json({ error: 'Failed to proxy offer to Live Avatar streamer: ' + (err.message || String(err)) });
  }
});

// ── Apple Watch avatar: HTTP proxy to the streamer's watch session ───────────
// (watchOS has no WebRTC; the streamer sends JPEG frames + PCM as NDJSON.)
app.post('/api/avatar/watch/start', async (req, res) => {
  try {
    const body = { ...(req.body ?? {}) };
    if (body.engine) {
      body.engine = { ...body.engine };
      pinCallback(body.engine, req);
    }
    await useAvailableAvatar(body, req);
    const r = await fetchFromStreamer('/api/avatar/watch/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    }, req.get('host'));
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(503).json({ error: 'Failed to reach Live Avatar streamer: ' + (err.message || String(err)) });
  }
});

app.get('/api/avatar/watch/stream', async (req, res) => {
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  try {
    const r = await fetchFromStreamer(`/api/avatar/watch/stream?session=${encodeURIComponent(String(req.query.session || ''))}`, { signal: ctrl.signal }, req.get('host'));
    res.writeHead(r.status, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    r.body.on('error', () => res.end());
    r.body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(503).json({ error: 'Failed to reach Live Avatar streamer: ' + (err.message || String(err)) });
    else res.end();
  }
});

app.post(['/api/avatar/watch/audio', '/api/avatar/watch/stop'], express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const r = await fetchFromStreamer(`${req.path}?session=${encodeURIComponent(String(req.query.session || ''))}`, {
      // X-Seq: the watch numbers its mic POSTs; the streamer drops late ones.
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(req.get('x-seq') ? { 'X-Seq': req.get('x-seq') } : {}) }, body: req.body?.length ? req.body : undefined,
      signal: AbortSignal.timeout(5000),
    }, req.get('host'));
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch (err) {
    res.status(503).json({ error: String(err.message || err) });
  }
});

app.post(['/api/avatar/upload', '/api/avatar/upload/', '/upload-avatar'], async (req, res) => {
  try {
    const { name, image, audio, gender, voice, prompt } = req.body;
    if (!name || !image) {
      return res.status(400).json({ error: 'Avatar name and image are required' });
    }

    const avatarId = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || `avatar_${Date.now()}`;

    // 1. Guard: Protect ANY currently existing avatar from being replaced or overwritten
    const isExisting = DEFAULT_AVATARS_LIST.some(a => a.toLowerCase() === avatarId);
    if (isExisting) {
      return res.status(409).json({
        error: `An avatar named "${name}" (ID: "${avatarId}") already exists. Please choose a unique name to avoid replacing an existing avatar.`
      });
    }

    const currentJob = AVATAR_TRAINING_JOBS.get(avatarId);
    if (currentJob && currentJob.status === 'training') {
      return res.status(409).json({
        error: `Avatar "${name}" is already currently training on the GPU.`
      });
    }

    // 2. Initialize Training Job
    const job = {
      avatarId,
      name: name.trim(),
      gender: gender || 'female',
      voice: voice || 'Kore',
      status: 'training',
      progress: 15,
      step: 'Uploading assets & preparing 16:9 widescreen canvas...',
      startedAt: Date.now(),
      error: null,
    };
    AVATAR_TRAINING_JOBS.set(avatarId, job);

    broadcastAvatarTraining('avatar_training_started', {
      job,
      trainingAvatars: Array.from(AVATAR_TRAINING_JOBS.values()).filter(j => j.status === 'training')
    });

    // 3. Immediately respond in async mode
    res.json({
      success: true,
      async: true,
      avatarId,
      name,
      job,
      message: 'Avatar generation started in background'
    });

    // 4. Execute the training & registration pipeline asynchronously
    (async () => {
      try {
        const refFramesDir = path.resolve(__dirname, '../live_avatar/artifacts/main/avatars_artifacts/reference_frames');
        const imagePath = path.join(refFramesDir, `${avatarId}.png`);

        if (!fs.existsSync(refFramesDir)) {
          fs.mkdirSync(refFramesDir, { recursive: true });
        }
        const imgBase64 = image.includes(',') ? image.split(',')[1] : image;
        fs.writeFileSync(imagePath, Buffer.from(imgBase64, 'base64'));

        const publicAvatarsDir = path.resolve(__dirname, '../public/avatars');
        if (!fs.existsSync(publicAvatarsDir)) {
          fs.mkdirSync(publicAvatarsDir, { recursive: true });
        }
        fs.writeFileSync(path.join(publicAvatarsDir, `${avatarId}.png`), Buffer.from(imgBase64, 'base64'));

        if (audio) {
          const refVoicesDir = path.resolve(__dirname, '../live_avatar/reference_voices');
          if (!fs.existsSync(refVoicesDir)) {
            fs.mkdirSync(refVoicesDir, { recursive: true });
          }
          const audioBase64 = audio.includes(',') ? audio.split(',')[1] : audio;
          const audioBuf = Buffer.from(audioBase64, 'base64');
          fs.writeFileSync(path.join(refVoicesDir, `${avatarId}.ogg`), audioBuf);
          fs.writeFileSync(path.join(refVoicesDir, `${avatarId}.wav`), audioBuf);
        }

        // Direct sync to WSL2 filesystem
        for (const wslPrefix of wslRoots()) {
          try {
            if (fs.existsSync(wslPrefix)) {
              const wslFrames = path.join(wslPrefix, 'root', 'avtr-1', 'artifacts', 'main', 'avatars_artifacts', 'reference_frames');
              if (!fs.existsSync(wslFrames)) fs.mkdirSync(wslFrames, { recursive: true });
              fs.writeFileSync(path.join(wslFrames, `${avatarId}.png`), Buffer.from(imgBase64, 'base64'));

              if (audio) {
                const wslVoices = path.join(wslPrefix, 'root', 'avtr-1', 'reference_voices');
                if (!fs.existsSync(wslVoices)) fs.mkdirSync(wslVoices, { recursive: true });
                const audioBase64 = audio.includes(',') ? audio.split(',')[1] : audio;
                const aBuf = Buffer.from(audioBase64, 'base64');
                fs.writeFileSync(path.join(wslVoices, `${avatarId}.ogg`), aBuf);
                fs.writeFileSync(path.join(wslVoices, `${avatarId}.wav`), aBuf);
              }
              break;
            }
          } catch (e) {}
        }

        job.progress = 35;
        job.step = 'Analyzing facial landmarks on the GPU...';
        broadcastAvatarTraining('avatar_training_progress', { job });

        job.progress = 60;
        job.step = 'Extracting speaker embeddings & GPT conditioning latents (XTTS-v2)...';
        broadcastAvatarTraining('avatar_training_progress', { job });

        try {
          const streamerResp = await fetchFromStreamer('/api/avatar/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              avatar_id: avatarId,
              name,
              image,
              audio,
              gender: gender || 'female',
              voice: voice || 'Kore',
              prompt: prompt || ''
            }),
            signal: AbortSignal.timeout(90000)
          });
          if (streamerResp.ok) {
            const streamData = await streamerResp.json().catch(() => ({}));
            console.log('[LiveAvatar] Streamer registered avatar:', streamData);
          } else {
            console.warn('[LiveAvatar] Streamer note:', streamerResp.status);
          }
        } catch (err) {
          console.log('[LiveAvatar] Streamer notify note:', err.message);
        }

        job.progress = 85;
        job.step = 'Pinning neural voice latents & avatar into GPU memory...';
        broadcastAvatarTraining('avatar_training_progress', { job });

        await new Promise(r => setTimeout(r, 600));

        // Mark Completed
        if (!DEFAULT_AVATARS_LIST.includes(avatarId)) {
          DEFAULT_AVATARS_LIST.push(avatarId);
        }

        job.status = 'ready';
        job.progress = 100;
        job.step = 'Avatar & neural voice clone ready in VRAM!';
        broadcastAvatarTraining('avatar_training_completed', {
          avatarId,
          name,
          job,
          avatars: DEFAULT_AVATARS_LIST
        });
        console.log(`[LiveAvatar] Avatar "${name}" (${avatarId}) training COMPLETED successfully!`);

        setTimeout(() => {
          if (AVATAR_TRAINING_JOBS.get(avatarId)?.status === 'ready') {
            AVATAR_TRAINING_JOBS.delete(avatarId);
          }
        }, 10000);

      } catch (err) {
        console.error(`[LiveAvatar] Avatar training failed for ${avatarId}:`, err);
        job.status = 'failed';
        job.error = err.message || 'Avatar training failed on GPU';
        broadcastAvatarTraining('avatar_training_failed', {
          avatarId,
          name,
          error: job.error,
          job
        });
      }
    })();

  } catch (err) {
    console.error('[LiveAvatar] Upload error:', err);
    return res.status(500).json({ error: err.message || 'Failed to start avatar upload' });
  }
});

const BUILTIN_AVATARS_SET = new Set([
  'maria', 'kate', 'clara', 'elena', 'may', 'camila', 'caroline',
  'ben', 'john', 'oliver', 'ming', 'jack', 'arnold', 'gordon', 'marcus', 'mozart', 'trevor'
]);

async function handleAvatarDelete(rawId, res) {
  try {
    if (!rawId) {
      return res.status(400).json({ error: 'avatarId is required' });
    }
    const avatarId = String(rawId).toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');

    if (BUILTIN_AVATARS_SET.has(avatarId)) {
      return res.status(403).json({ error: `Cannot delete built-in system avatar "${avatarId}".` });
    }

    console.log(`[LiveAvatar] Deleting custom avatar "${avatarId}"...`);

    // 1. Remove from in-memory lists & active training jobs
    const idx = DEFAULT_AVATARS_LIST.indexOf(avatarId);
    if (idx !== -1) {
      DEFAULT_AVATARS_LIST.splice(idx, 1);
    }
    AVATAR_TRAINING_JOBS.delete(avatarId);

    // 2. Remove Windows disk assets
    const refFramesDir = path.resolve(__dirname, '../live_avatar/artifacts/main/avatars_artifacts/reference_frames');
    const publicAvatarsDir = path.resolve(__dirname, '../public/avatars');
    const refVoicesDir = path.resolve(__dirname, '../live_avatar/reference_voices');

    const filesToDelete = [
      path.join(refFramesDir, `${avatarId}.png`),
      path.join(publicAvatarsDir, `${avatarId}.png`),
      path.join(refVoicesDir, `${avatarId}.ogg`),
      path.join(refVoicesDir, `${avatarId}.wav`),
    ];

    for (const f of filesToDelete) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {
        console.warn(`[LiveAvatar] Failed to unlink ${f}:`, e.message);
      }
    }

    // 3. Remove WSL2 disk assets via UNC path
    for (const wslPrefix of wslRoots()) {
      try {
        if (fs.existsSync(wslPrefix)) {
          const wslPng = path.join(wslPrefix, 'root', 'avtr-1', 'artifacts', 'main', 'avatars_artifacts', 'reference_frames', `${avatarId}.png`);
          const wslOgg = path.join(wslPrefix, 'root', 'avtr-1', 'reference_voices', `${avatarId}.ogg`);
          const wslWav = path.join(wslPrefix, 'root', 'avtr-1', 'reference_voices', `${avatarId}.wav`);
          if (fs.existsSync(wslPng)) fs.unlinkSync(wslPng);
          if (fs.existsSync(wslOgg)) fs.unlinkSync(wslOgg);
          if (fs.existsSync(wslWav)) fs.unlinkSync(wslWav);
          break;
        }
      } catch (e) {}
    }

    // 4. Notify Streamer and Renderer
    try {
      await fetchFromStreamer(`/api/avatar/${avatarId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(4000)
      }).catch(() => {});
    } catch (e) {}

    try {
      await fetch(`http://127.0.0.1:8000/avatars/${avatarId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(4000)
      }).catch(() => {});
    } catch (e) {}

    // 5. Broadcast deletion to connected frontend clients
    clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) {
        c.send(JSON.stringify({
          type: 'avatar_deleted',
          avatarId,
          avatars: DEFAULT_AVATARS_LIST
        }));
      }
    });

    console.log(`[LiveAvatar] Avatar "${avatarId}" deleted successfully.`);
    return res.json({
      success: true,
      avatarId,
      avatars: DEFAULT_AVATARS_LIST,
      message: `Avatar "${avatarId}" has been deleted.`
    });

  } catch (err) {
    console.error(`[LiveAvatar] Error deleting avatar "${rawId}":`, err);
    return res.status(500).json({ error: err.message || 'Failed to delete avatar' });
  }
}

app.delete(['/api/avatar/:avatarId', '/api/avatar/:avatarId/'], async (req, res) => {
  return handleAvatarDelete(req.params.avatarId, res);
});

app.post(['/api/avatar/delete', '/api/avatar/delete/'], async (req, res) => {
  return handleAvatarDelete(req.body.avatarId || req.body.name, res);
});

// phone_action for the live avatar's Gemini session (the streamer): it fetches the
// declaration at session start (one definition, here) and posts calls back.
app.get('/api/device/tool', (req, res) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!isAuthorized(key, process.env, req.path)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ tool: PHONE_ACTION_TOOL, prompt: PHONE_ACTION_PROMPT });
});

app.post('/api/device/action', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!isAuthorized(key, process.env, req.path)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ result: await phoneBridge.run(req.body || {}) });
});

// Cloned voice served by this machine's voice server (live_avatar/voice_server, port
// 8010) to the avatar streamer of another machine (its XTTS_URL points here).
app.post('/api/voice/synthesize', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!isAuthorized(key)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.VOICE_SERVER_PORT || 8010}/api/voice/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(30000),
    });
    const pcm = Buffer.from(await r.arrayBuffer());
    res.status(r.status).set('Content-Type', r.headers.get('content-type') || 'application/octet-stream').send(pcm);
  } catch (e) {
    res.status(503).json({ error: `Voice server unreachable: ${e.message}` });
  }
});

// Streaming variant: PCM pieces are forwarded as XTTS generates them.
app.post('/api/voice/stream', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!isAuthorized(key)) return res.status(401).json({ error: 'Unauthorized' });
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.VOICE_SERVER_PORT || 8010}/api/voice/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: ctrl.signal,
    });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    r.body.on('error', () => res.end());
    r.body.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(503).json({ error: `Voice server unreachable: ${e.message}` });
    else res.end();
  }
});

// What the user says to the avatar, one line per utterance (avatar/utteranceJoiner.js).
// Did the avatar say anything since the user's last utterance? (else Jarvis acknowledges)
const avatarTurn = { said: false, userText: '' };
const avatarUserSpeech = new UtteranceJoiner({
  onUtterance: (text) => {
    Object.assign(avatarTurn, { said: false, userText: text });
    broadcast({ type: 'voice_transcript', text, role: 'user', is_final: true });
  },
});

app.post('/api/avatar/delegate', async (req, res) => {
  avatarUserSpeech.flush(); // the request is out: the user's utterance is complete
  if (!avatarTurn.said && req.body?.task) {
    // The avatar skipped its acknowledgement: never start a task in silence.
    const ack = acknowledgement(req.body.agent || 'agy', avatarTurn.userText || req.body.task, activeLanguage);
    broadcastLog(`JARVIS: ${ack}`);
    broadcast({ type: 'voice_transcript', text: ack, role: 'assistant', is_final: true });
    avatarTurn.said = true;
  }
  try {
    const { task, agent = 'agy' } = req.body;
    if (!task) return res.status(400).json({ error: 'Task required' });
    broadcastLog(`[LIVE AVATAR DELEGATION] Forwarding task to ${agent.toUpperCase()}: ${task}`);
    const result = await geminiLiveProvider.delegateToAgent(task, agent, true);
    if (result && typeof result === 'string') {
      broadcast({
        type: 'agent_result',
        agentId: agent,
        agentName: agent.toUpperCase(),
        result: result,
      });
    }
    res.json({ result: result || 'Task executed successfully.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(['/api/avatar/transcript', '/api/avatar/transcript/'], async (req, res) => {
  try {
    const { text, role = 'assistant', is_final = true } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    // 1. The live caption, and the activity log once per utterance (the app logs the user's
    //    final lines itself: no second "[LIVE AVATAR] User:" line).
    if (role === 'user') {
      broadcast({ type: 'voice_transcript', text: avatarUserSpeech.add(text), role, is_final: false });
      return res.json({ ok: true });
    }
    avatarUserSpeech.flush(); // Jarvis answers: the user's utterance is complete
    avatarTurn.said = true;
    broadcast({ type: 'voice_transcript', text, role, is_final });
    if (is_final) broadcastLog(`[LIVE AVATAR] Jarvis: ${text}`);

    // 2. Only broadcast agent_result if the assistant output contains a 3D model or rich visual media artifact
    if (role === 'assistant' && is_final) {
      const has3DMedia = /\.(glb|gltf|obj|stl|fbx)(\?|$|\s|\))/i.test(text) || text.includes('/api/local-image');
      if (has3DMedia) {
        broadcast({
          type: 'agent_result',
          agentId: 'live-avatar',
          agentName: 'JARVIS // LIVE AVATAR',
          result: text,
          isDelegated: true,
        });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/avatar/speak', async (req, res) => {
  try {
    const { text, language = 'en', force = true } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    ttsEngine.speak(text, language, geminiLiveMode, activeModel, { force });
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const rssParser = new RSSParser();
// JARVIS_DATA_DIR: the packaged Jarvis Server keeps them out of its (replaceable) install folder.
const DATA_DIR = process.env.JARVIS_DATA_DIR || path.resolve('..');
const HEALTH_FILE = path.join(DATA_DIR, 'health_export.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const conversationMemory = new ConversationMemory(MEMORY_FILE, 100);

function writeMemoryTurn(role, text) {
  conversationMemory.writeTurn(role, text);
}

// Your Base wallet address for the wallet card (optional; Settings → Integrations, or CRYPTO_WALLET).
let CRYPTO_WALLET = process.env.CRYPTO_WALLET || '';
let ttsServer = process.env.TTS_SERVER || 'http://127.0.0.1:8000';
global.TTS_SERVER = ttsServer;

// ── Ollama cluster ──────────────────────────────────────────────────────────
let OLLAMA_SERVERS = process.env.OLLAMA_SERVERS 
  ? process.env.OLLAMA_SERVERS.split(',').map(s => s.trim()).filter(Boolean)
  : [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
    ];
let activeGenerations = new Map(OLLAMA_SERVERS.map(url => [url, 0]));

function pickOllamaServer(exclude = []) {
  const available = OLLAMA_SERVERS.filter(url => !exclude.includes(url));
  if (available.length === 0) return OLLAMA_SERVERS[Math.floor(Math.random() * OLLAMA_SERVERS.length)];
  const loads = available.map(url => activeGenerations.get(url));
  const minLoad = Math.min(...loads);
  const candidates = available.filter(url => activeGenerations.get(url) === minLoad);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ── HTTP Server + WebSocket ─────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ 
  server,
  verifyClient: (info, cb) => {
    const url = new URL(info.req.url, `http://${info.req.headers.host}`);
    const key = info.req.headers['x-api-key'] || url.searchParams.get('api_key') || info.req.headers['sec-websocket-protocol'];
    if (isAuthorized(key)) {
      cb(true);
    } else {
      cb(false, 401, 'Unauthorized');
    }
  }
});
const clients = new Set();
// phone_action tool calls → the phone that registered with device_hello.
const phoneBridge = new PhoneBridge({ log: (msg) => broadcastLog(msg) });

// Jarvis's voice goes to the device you're talking from — the client that last turned
// its mic on — not to every client: talking from the watch made the phone answer too.
let voiceOwner = null;
function voiceTargets() {
  return voiceOwner && voiceOwner.readyState === WebSocket.OPEN ? [voiceOwner] : [...clients];
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  const targets = msg.type === 'tts_chunk' ? voiceTargets() : clients;
  targets.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}
function broadcastLog(message) { broadcast({ type: 'log', message }); }
function broadcastAgentStatus(agentId, status, prompt = null) {
  broadcast({ type: 'agent_status', agentId, status, ...(prompt ? { prompt } : {}) });
}
function broadcastStream(agentId, token) { broadcast({ type: 'stream', agentId, token }); }
function broadcastAlert(message) {
  broadcast({ type: 'alert', message });
  broadcastNotification({ label: 'SYSTEM ALERT', msg: message, kind: 'warn' });
}
function broadcastNotification(notif) {
  broadcast({ type: 'notification', ...notif });
}

// ── Pocket TTS Interceptor ──────────────────────────────────────────────────
let activeModel = 'gemini';
let activeLanguage = 'en';
let selectedModels = { hermes: 'nvidia/nemotron-3-super-120b-a12b:free', gemini: 'gemini-3.8-flash', claude: 'claude-3-haiku-20240307' };

/** `agy` arguments for the selected Gemini model, valid for this agy's model list (agents/agyModel.js). */
// Voice delegations: someone is waiting on the answer → the chosen model at low effort
// (JARVIS_VOICE_AGENT_EFFORT=selected keeps the chosen effort).
const VOICE_AGENT_EFFORT = process.env.JARVIS_VOICE_AGENT_EFFORT || 'low';
async function agyArgs({ voice = false } = {}) {
  const models = (await detectAgents().catch(() => ({ agents: [] }))).agents.find((a) => a.id === 'gemini')?.models || [];
  const effort = voice && VOICE_AGENT_EFFORT !== 'selected' ? VOICE_AGENT_EFFORT : undefined;
  return agyModelArgs(selectedModels.gemini, models, { effort });
}
let lastUserVoiceCommand = '';
let micActive = true;
let originalMicVolume = 100;
let geminiLiveMode = true;
// Which Gemini session hears the user: the backend's Live session (orb) or the
// avatar streamer's own session. Reported by the mobile app; drives vision routing.
let avatarModeActive = false;

/** Sends a camera / screen frame to whichever Gemini session is talking to the user. */
function routeVisionFrame(mimeType, data, reqHost = '') {
  if (!data) return;
  if (avatarModeActive) {
    fetchFromStreamer('/vision-frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mimeType: mimeType || 'image/jpeg', data }),
      signal: AbortSignal.timeout(3000),
    }, reqHost).catch((e) => console.error('[VISION] Avatar streamer frame error:', e.message));
    return;
  }
  if (geminiLiveMode && geminiLiveProvider.session) {
    try {
      geminiLiveProvider.session.sendRealtimeInput({ video: { mimeType: mimeType || 'image/jpeg', data } });
    } catch (e) {
      console.error('[GEMINI LIVE] Vision frame send error:', e.message);
    }
  }
}

const GEMINI_OAUTH_FILE = path.join(os.homedir(), '.gemini', 'oauth_creds.json');

function getGeminiAccessToken() {
  try {
    const creds = JSON.parse(fs.readFileSync(GEMINI_OAUTH_FILE, 'utf8'));
    return creds.access_token;
  } catch(e) {
    return null;
  }
}

function createGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (apiKey) {
    console.log('[GEMINI] Using API key from environment');
    return new GoogleGenAI({ apiKey });
  }
  const token = getGeminiAccessToken();
  if (token) {
    console.log('[GEMINI] Using OAuth access token from ~/.gemini/oauth_creds.json');
    return new GoogleGenAI({ apiKey: token });
  }
  console.warn('[GEMINI] No credentials found. Add GEMINI_API_KEY to .env or run `agy auth`');
  return new GoogleGenAI({});
}

const ttsEngine = new TTSEngine({
  onStateChange: () => updateSTTMode(),
  onBroadcast: (msg) => broadcast(msg)
});

let lastVoiceCommandTime = 0;
let lastVoiceCommandText = '';

const sttProxy = new STTProxy({
  onLog: (msg) => console.log(msg),
  onNotification: (notif) => broadcastNotification(notif),
  isTtsSpeaking: () => ttsEngine.speakingInstances > 0 || Date.now() - ttsEngine.lastSpeechEndTime < 3500,
  onWakeWord: () => {
    broadcast({ type: 'wake_detected' });
    broadcastLog('[JARVIS] Wake word detected');
    if (!geminiLiveMode) {
      const phrases = {
        'en': 'Yes, Sir?', 'fr': 'Oui, monsieur ?', 'de': 'Ja, mein Herr?',
        'pt': 'Sim, senhor?', 'it': 'Sì, signore?', 'es': '¿Sí, señor?'
      };
      speak(phrases[activeLanguage] || phrases['en']);
    }
  },
  onPartial: (text) => {
    if (geminiLiveMode) return;
    broadcast({ type: 'voice_transcript', text, role: 'user', is_final: false });
  },
  onFinal: (text) => {
    if (geminiLiveMode) return;
    const cleanText = text.toLowerCase();
    const now = Date.now();
    if (now - lastVoiceCommandTime < 2500 && (cleanText === lastVoiceCommandText || !cleanText)) {
      console.log(`[STT] Suppressed duplicate stt_final within 2.5s: "${text}"`);
      return;
    }
    lastVoiceCommandTime = now;
    lastVoiceCommandText = cleanText;
    lastUserVoiceCommand = text;
    writeMemoryTurn('user', text);
    console.log(`[STT] Final transcript → lastUserVoiceCommand: "${text}"`);
    broadcast({ type: 'voice_transcript', text, role: 'user', is_final: true });
    
    cancelActiveCommands();
    handleOrchestration(text, 'voice');
  }
});
sttProxy.connect();

function updateSTTMode() {
  if (ttsEngine.isFetchingAudio || ttsEngine.isPlayingAudio || ttsEngine.audioFilesQueue.length > 0) {
    sttProxy.send({ type: 'wake_only' });
  } else {
    if (micActive) {
      sttProxy.send({ type: 'full_mode' });
    }
  }
}

function stopSpeaking() {
  ttsEngine.stopSpeaking();
}

function speak(speechText, options = { interrupt: true }) {
  ttsEngine.speak(speechText, activeLanguage, geminiLiveMode, activeModel, options);
}

// (STTProxy logic has been moved out)

// ── WebSocket Client Handler ────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  // Send initial state on connect
  sendInitialData(ws);
  ws.send(JSON.stringify({ type: 'state_sync', activeModel, selectedModels, geminiLiveMode, activeLanguage }));

  ws.on('message', (message, isBinary) => handleClientMessage(ws, message, isBinary));
  ws.on('close', () => { clients.delete(ws); phoneBridge.unregister(ws); if (voiceOwner === ws) voiceOwner = null; });
});

/**
 * One message from a client — a phone/web WebSocket or a watch HTTP session
 * (anything with send() and readyState). Binary = mic PCM, text = JSON command.
 */
function handleClientMessage(ws, message, isBinary) {
  if (isBinary) {
    let payload = Buffer.from(message);
    if (payload.length >= 12 && payload.slice(0, 4).toString('ascii') === 'AUDO') {
      payload = payload.slice(12);
    } else if (payload.length >= 8) {
      const first4 = payload.readUInt32BE(0);
      if (first4 < 1000000000 && payload.length > 8) {
        payload = payload.slice(8);
      }
    }

    if (geminiLiveMode && geminiLiveProvider.session) {
      try {
        geminiLiveProvider.session.sendRealtimeInput({
          audio: {
            data: payload.toString('base64'),
            mimeType: 'audio/pcm;rate=24000'
          }
        });
      } catch(e) {}
    } else if (sttProxy.ws && sttProxy.ws.readyState === WebSocket.OPEN) {
      try {
        sttProxy.ws.send(payload);
      } catch(e) {}
    }
    return;
  } else {
    try {
      const data = JSON.parse(message);
      if (data.type === 'set_gemini_live_mode') {
        geminiLiveMode = data.enabled;
        console.log(`[STATE] Gemini Live Mode: ${geminiLiveMode}`);
        broadcastLog(`[SYSTEM] Gemini Live Mode ${geminiLiveMode ? 'ENABLED' : 'DISABLED'}`);
        syncGeminiLiveState();
        broadcast({ type: 'state_sync', geminiLiveMode });
      }
      // The phone announces which phone_action actions it can run, then answers them.
      if (data.type === 'device_hello') {
        phoneBridge.register(ws, { platform: data.platform, actions: data.actions });
      }
      if (data.type === 'watch_audio_diag') {
        lastWatchAudioDiag = { ...(data.diag || {}), at: new Date().toISOString() };
      }
      if (data.type === 'device_action_result') {
        phoneBridge.handleResult(data);
      }
      if (data.type === 'set_avatar_mode') {
        avatarModeActive = !!data.enabled;
        console.log(`[STATE] Live Avatar mode: ${avatarModeActive}`);
      }
      if (data.type === 'vision_frame') {
        routeVisionFrame(data.mimeType, data.data);
      }
      if (data.type === 'set_model') {
        activeModel = data.model;
        console.log(`[STATE] Active model set to: ${activeModel}`);
        broadcastLog(`[SYSTEM] Switched AI Model to ${activeModel.toUpperCase()}`);
        syncGeminiLiveState();
        broadcast({ type: 'state_sync', activeModel });
      }
      if (data.type === 'set_specific_model') {
        selectedModels[data.agent] = data.model;
        console.log(`[STATE] Specific model for ${data.agent.toUpperCase()} set to: ${data.model}`);
        broadcast({ type: 'state_sync', selectedModels });
      }
        if (data.type === 'set_language') {
        activeLanguage = data.language || 'eng';
        console.log(`[STATE] Language set to: ${activeLanguage}`);
        broadcast({ type: 'tts_ready' });
        syncGeminiLiveState();
        sttProxy.setLanguage(activeLanguage);
      }
      if (data.type === 'command') {
        cancelActiveCommands();
        const text = data.payload || data.text;
        handleOrchestration(text, 'text');
      }
      // voice_command: accurate transcription from browser WebSpeech API (primary path)
      // Skip when Gemini Live is active — Gemini Live handles voice end-to-end
      if (data.type === 'voice_command') {
        if (geminiLiveMode) {
          console.log(`[VOICE_CMD] Suppressed (Gemini Live active): "${data.text?.slice(0, 60)}"`);
        } else {
          const now = Date.now();
          const cleanText = data.text?.trim().toLowerCase();
          if (ttsEngine?.isPlayingAudio || (now - (ttsEngine?.lastSpeechEndTime || 0) < 1200)) {
            console.log(`[VOICE_CMD] Suppressed acoustic echo while speaking: "${cleanText}"`);
            return;
          }
          if (now - lastVoiceCommandTime < 2500 && (cleanText === lastVoiceCommandText || !cleanText)) {
            console.log(`[VOICE_CMD] Suppressed duplicate voice_command within 2.5s: "${cleanText}"`);
            return;
          }
          lastVoiceCommandTime = now;
          lastVoiceCommandText = cleanText;
          cancelActiveCommands();
          handleOrchestration(data.text, 'voice');
        }
      }
      if (data.type === 'mic_toggle') {
        if (data.active) voiceOwner = ws;
        micActive = data.active;
        sttProxy.setMicActive(data.active);
        syncGeminiLiveState();
        if (data.active === true && activeModel !== 'gemini') {
          setTimeout(() => {
            const phrases = {
              'en': 'Hi sir, how can I help you today?',
              'fr': 'Bonjour monsieur, comment puis-je vous aider aujourd\'hui ?',
              'de': 'Hallo, wie kann ich Ihnen heute helfen?',
              'pt': 'Olá senhor, como posso ajudá-lo hoje?',
              'it': 'Salve signore, come posso aiutarla oggi?',
              'es': 'Hola señor, ¿cómo puedo ayudarle hoy?'
            };
            speak(phrases[activeLanguage] || phrases['en']);
          }, 400);
        }
      }
      if (data.type === 'stop_tts') {
        console.log('[SYSTEM] Stopping TTS playback');
        stopSpeaking();
      }
      if (data.type === 'get_state') {
        sendInitialData(ws);
      }
    } catch(e) {}
  }
}

// ── Apple Watch transport (plain HTTP: watchOS blocks WebSockets) ─────────────
// GET  /api/watch/events  long-lived NDJSON stream; the session is a broadcast client
// POST /api/watch/send    JSON command (same messages as the WebSocket)
// POST /api/watch/audio   raw 24 kHz s16 mono mic PCM
const watchSessions = new Map();

class WatchClient {
  constructor(res) {
    this.res = res;
    this.readyState = WebSocket.OPEN;
  }
  send(data) {
    if (this.readyState !== WebSocket.OPEN) return;
    try { this.res.write((typeof data === 'string' ? data : JSON.stringify(data)) + '\n'); } catch (e) {}
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    clients.delete(this);
    if (voiceOwner === this) voiceOwner = null;
  }
}

app.get('/api/watch/events', (req, res) => {
  const id = String(req.query.session || '');
  if (!id) return res.status(400).json({ error: 'session required' });
  watchSessions.get(id)?.close();
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  const client = new WatchClient(res);
  watchSessions.set(id, client);
  clients.add(client);
  client.send({ type: 'state_sync', activeModel, selectedModels, geminiLiveMode, activeLanguage });
  // Keeps proxies (Cloudflare) from closing an idle stream.
  const ping = setInterval(() => client.send({ type: 'ping' }), 15000);
  req.on('close', () => {
    clearInterval(ping);
    client.close();
    if (watchSessions.get(id) === client) watchSessions.delete(id);
  });
});

// The watch's last audio report (route, volume, errors) — for silent playback.
let lastWatchAudioDiag = null;
app.get('/api/watch/diag', (req, res) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!isAuthorized(key)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ diag: lastWatchAudioDiag });
});

app.post('/api/watch/send', (req, res) => {
  const client = watchSessions.get(String(req.query.session || '')) ?? new WatchClient(res);
  handleClientMessage(client, JSON.stringify(req.body ?? {}), false);
  res.json({ ok: true });
});

app.post('/api/watch/audio', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const client = watchSessions.get(String(req.query.session || ''));
  if (!client) return res.status(404).json({ error: 'no watch session' });
  if (req.body?.length) handleClientMessage(client, req.body, true);
  res.json({ ok: true });
});

async function sendInitialData(ws) {
  try {
    // 1. Send state sync
    ws.send(JSON.stringify({ 
      type: 'state_sync', 
      activeModel, 
      selectedModels, 
      geminiLiveMode, 
      activeLanguage 
    }));

    // 2. Send latest feed
    if (cachedFeed && cachedFeed.length > 0) {
      ws.send(JSON.stringify({ type: 'feed', items: cachedFeed }));
    } else {
      getFeedItems().then(items => {
        cachedFeed = items;
        if (ws.readyState === WebSocket.OPEN && cachedFeed.length > 0) {
          ws.send(JSON.stringify({ type: 'feed', items: cachedFeed }));
        }
      }).catch(() => {});
    }

    // 3. Send latest crypto
    if (cachedCrypto) {
      ws.send(JSON.stringify({ type: 'crypto', data: cachedCrypto }));
    } else {
      getCryptoData().then(cData => {
        cachedCrypto = cData;
        if (ws.readyState === WebSocket.OPEN && cachedCrypto) {
          ws.send(JSON.stringify({ type: 'crypto', data: cachedCrypto }));
        }
      }).catch(() => {});
    }

    // 4. Send latest telemetry
    try {
      const data = await getTelemetry();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'telemetry', data }));
      }
    } catch(e) {}

    // 5. Send initial log
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        type: 'log', 
        message: `[SYSTEM] JARVIS Neural Core v2.4 Online. Active Model: ${activeModel.toUpperCase()}` 
      }));
    }
  } catch (e) {
    console.error('[WS] sendInitialData error:', e.message);
  }
}

// ── JSON extraction ─────────────────────────────────────────────────────────
function extractFirstJSON(text) {
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      if (--depth === 0 && start !== -1) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── Agent role map ──────────────────────────────────────────────────────────
const AGENT_ROLES = {
  odin:    'Strategic Command & Governance specialist',
  stark:   'Engineering, Technical & Code specialist',
  vision:  'Analysis, Intelligence & Logic specialist',
  ultron:  'Security & Automation specialist',
  friday:  'Operations, Weather & General Utility specialist',
  veronica:'Deployment & Infrastructure specialist',
  athena:  'Research, News & Documentation specialist',
  steve:   'Ethics & Impact Analysis specialist',
};

// ── Hermes agent runner ──────────────────────────────────────────────────────
const HERMES_BIN = getCrossPlatformCommand('hermes', false);  // use default hermes profile
const HERMES_MODEL = 'google/gemma-4-12b-qat';

// Maps cluster URLs to named providers defined in your Hermes profile config
// (HERMES_SERVER_PROVIDERS='https://host/v1=provider,…'). Hermes ignores OPENAI_BASE_URL when the
// profile config has model.base_url set; --provider <name> is the correct override path.
const HERMES_SERVER_PROVIDERS = Object.fromEntries(
  String(process.env.HERMES_SERVER_PROVIDERS || '').split(',').map((s) => s.split('=').map((x) => x.trim())).filter(([u, p]) => u && p),
);

// Strip activation prefixes from raw STT before passing task to agent.
function cleanAgentTask(text) {
  return text
    // "fire 1 agent Stark ..."
    .replace(/^(?:fire|activate|launch|call|use|engage|deploy|assign|send)\s+(?:\d+\s+)?agents?\s+\w+\s*/i, '')
    // "I am / I'm a [web] [agent] to/for ..." — STT echo of Jarvis's confirmation speech
    .replace(/^i(?:'m| am)\s+(?:a\s+)?(?:\w+\s+){0,2}(?:agent\s+)?(?:to\s+|for\s+)?/i, '')
    .trim() || text;
}

function cleanHermesOutput(raw) {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // ANSI escape codes
    .replace(/\x1b[^[]/g, '')                   // other escape sequences
    .replace(/\r/g, '')                          // carriage returns
    .replace(/^[╭╰│╮╯─].*$/gm, '')           // box-drawing banner lines and solid line separators
    .replace(/^Warning:.*$/gmi, '')              // warnings
    .replace(/^Query:.*$/gmi, '')                // CLI echo
    .replace(/^Initializing agent.*$/gmi, '')    // CLI startup message
    .replace(/^session_id:.*$/gm, '')            // session metadata
    .replace(/^.*┊.*$/gm, '')                    // tool-progress lines (┊ prefix)
    .replace(/^.*🔧.*$/gm, '')                   // auto-repair notices
    .replace(/^.*\b(snapshot|navigate|browser_|terminal_|file_)\b.*$/gm, '') // stray tool traces
    .replace(/\n{3,}/g, '\n\n')                  // collapse excess blank lines
    .trim();
}

const agentSessions = new Map();



// Condense agent result into a natural spoken brief and send to PersonaPlex TTS.
function speakAgentResult(agentId, result) {
  // Strip markdown synchronously — no LLM call, fires immediately when overlay opens.
  const spoken = result
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/[*`_~]/g, '')
    .replace(/^[-▸•]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 450);
  if (spoken) {
    broadcastLog(`JARVIS: ${spoken}`);
    speak(spoken);
  }
}

// ── Ollama ──────────────────────────────────────────────────────────────────
const PLANNER_MODEL = 'tencent/hy3:free'; // Using Ollama
let isOrchestrating = false;
let activeProcesses = new Set();
let voiceAccumulator = '';
let voiceDebounceTimer = null;
let lastWebSpeechTime = 0; // track when WebSpeech last fired so Moshi doesn't double-orchestrate

function cancelActiveCommands() {
  stopSpeaking();
  if (activeProcesses.size > 0) {
    broadcastLog(`[SYSTEM] Canceling previous command...`);
    for (const proc of activeProcesses) {
      proc.killedByUser = true;
      try { proc.kill('SIGTERM'); } catch(e) {}
    }
    activeProcesses.clear();
  }
  isOrchestrating = false;
  if (voiceDebounceTimer) {
    clearTimeout(voiceDebounceTimer);
    voiceDebounceTimer = null;
  }
  voiceAccumulator = '';
  broadcastAgentStatus('jarvis', 'IDLE');
  broadcastAgentStatus(activeModel, 'IDLE');
}

async function callOllamaChatResilient(messages, model = 'qwen3.5-0.8b', onStream = null, bodyExtra = {}) {
  const tried = new Set();
  let lastError = null;

  while (tried.size < OLLAMA_SERVERS.length) {
    const serverUrl = pickOllamaServer([...tried]);
    tried.add(serverUrl);
    activeGenerations.set(serverUrl, (activeGenerations.get(serverUrl) || 0) + 1);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), onStream ? 90000 : 45000);

    try {
      // Hardcode routing to the 'nous' provider for the tencent model
      const isNousModel = model.includes('tencent/hy3') || model.includes('stepfun') || model.includes('step-3.7');
      const fetchUrl = isNousModel ? 'http://localhost:3000/v1/chat/completions' : `${serverUrl}/chat/completions`;

      const res = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ollama' },
        body: JSON.stringify({ model, messages, stream: !!onStream, options: { num_ctx: 8192 }, ...bodyExtra }),
        signal: controller.signal,
      });

      if (!res.ok) {
        clearTimeout(timeoutId);
        const errText = await res.text();
        activeGenerations.set(serverUrl, Math.max(0, activeGenerations.get(serverUrl) - 1));
        lastError = new Error(`HTTP ${res.status} from ${serverUrl}: ${errText.slice(0, 120)}`);
        console.warn(`⚠️ ${serverUrl} → ${res.status}. Trying next server...`);
        continue;
      }

      if (onStream) {
        // Keep timeout active through the entire stream — a hung server will be aborted
        for await (const chunk of res.body) {
          const raw = chunk.toString();
          for (const line of raw.split('\n')) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6);
              if (dataStr === '[DONE]') continue;
              try {
                const json = JSON.parse(dataStr);
                const token = json.choices?.[0]?.delta?.content;
                if (token) onStream(token);
              } catch(e) {}
            }
          }
        }
        clearTimeout(timeoutId);
        activeGenerations.set(serverUrl, Math.max(0, activeGenerations.get(serverUrl) - 1));
        return '';
      } else {
        const json = await res.json();
        clearTimeout(timeoutId);
        activeGenerations.set(serverUrl, Math.max(0, activeGenerations.get(serverUrl) - 1));
        const msg = json.choices?.[0]?.message;
        // Qwen3 thinking models put the final answer in content; fall back to
        // reasoning_content if content is empty (older Ollama builds behave this way)
        return msg?.content || msg?.reasoning_content || '';
      }
    } catch (err) {
      clearTimeout(timeoutId);
      activeGenerations.set(serverUrl, Math.max(0, activeGenerations.get(serverUrl) - 1));
      lastError = err;
      console.warn(`⚠️ ${serverUrl} → ${err.message}. Trying next server...`);
    }
  }

  throw lastError || new Error('All Ollama servers unavailable');
}

// Shared structured prompt for Gemini and Claude CLI invocations.
function buildTaskQuery(command, { voice = false } = {}) {
  const task = cleanAgentTask(command);
  const now = new Date().toLocaleString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  // The agent otherwise runs `date` first, and opens page after page: ~3-5 s per model turn.
  const speed = voice
    ? `\nA voice assistant is waiting to read your answer out loud, so speed matters: do only the steps the task needs. For a question, one or two web searches are usually enough — answer from what they return instead of opening pages one by one. Don't check the date or explore the system unless the task is about it.`
    : '';
  return `## Context
Now: ${now}.${speed}
You are running on the user's macOS machine. You have FULL ACCESS to the system via your terminal tool. Use commands like \`osascript\` (AppleScript) or \`open\` to control apps (like Spotify), change settings, open URLs, etc. NEVER say you lack access.
If asked to play specific music/artists on Spotify, ALWAYS first use your web search tool to find their exact Spotify URI (e.g. spotify:artist:... or spotify:track:...), then use AppleScript to play that specific URI via osascript.
CRITICAL MEDIA RULE: If asked to find, show, or load a media file (Video, Audio, PDF) or a 3D Object (.obj, .glb, .gltf) from the internet, DO NOT open the file in a browser and take a screenshot! You MUST securely download the actual file to the local filesystem and output a markdown link pointing to its absolute path (e.g. \`[Model](file:///absolute/path/to/model.obj)\` or \`[Video](file:///absolute/path/to/video.mp4)\`). The Jarvis overlay will natively intercept this link and render it interactively.

## Task
${task}

## Response Format
- Lead immediately with the key findings or confirm completion
- If you downloaded a media/3D file, immediately provide the markdown link to it (e.g. \`[Model](file:///absolute/path/to/model.obj)\`)
- Use clean markdown
- No filler phrases or padding`;
}

// ── Workers ────────────────────────────────────────────────────────
const workerContext = {
  broadcast,
  broadcastLog,
  broadcastAgentStatus,
  broadcastAlert,
  getSelectedModel: (agent) => selectedModels[agent],
  agyModelArgs: (opts) => agyArgs(opts),
  buildTaskQuery,
  registerProcess: (proc) => activeProcesses.add(proc),
  unregisterProcess: (proc) => activeProcesses.delete(proc),
  speak: speak,
  queueVoiceTTS: (text) => {
    if (voiceSocket?.readyState === WebSocket.OPEN) {
      voiceSocket.send(JSON.stringify({ type: 'tts', text }));
    }
  },
  resumeSTTMode: (source) => {
    if (source === 'voice') {
      setTimeout(() => {
        if (micActive) sttProxy.send({ type: 'full_mode' });
      }, 2000);
    }
  },
  pickOllamaServer,
  getAgentSession: (agentId) => agentSessions.get(agentId) || '',
  setAgentSession: (agentId, sid) => agentSessions.set(agentId, sid),
  cleanHermesOutput,
  speakAgentResult,
  cleanAgentTask,
  getAgentRole: (agentId) => AGENT_ROLES[agentId.toLowerCase()]
};

const agyWorker = new AgyWorker(workerContext);
const claudeWorker = new ClaudeWorker(workerContext);
const hermesWorker = new HermesCLIWorker(workerContext);

const workerRegistry = new WorkerRegistry();
workerRegistry.register(agyWorker);
workerRegistry.register(claudeWorker);
workerRegistry.register(hermesWorker);

const capabilityRegistry = new CapabilityRegistry();
// Register default capabilities for the hermes cli worker
capabilityRegistry.register('hermes', ['Terminal', 'Filesystem', 'Research', 'Coding', 'Browser']);

const hermesRuntime = new HermesRuntime(workerRegistry, capabilityRegistry);

// Make the eventBus available to context for streaming tokens
workerContext.eventBus = hermesRuntime.eventBus;

const conversationRuntime = new ConversationRuntime({
  hermesRuntime,
  speak,
  broadcast,
  broadcastLog,
  broadcastAgentStatus,
  executeFallbackOrchestration: (cmd, src) => executeOrchestration(cmd, src),
  runHermesAgent: (agentId, cmd) => runHermesAgent(agentId, cmd)
});
const geminiLiveProvider = new GeminiLiveProvider({
  createClient: createGeminiClient,
  phoneBridge,
  broadcast,
  broadcastAudioChunk,
  broadcastLog,
  broadcastNotification,
  broadcastAgentStatus,
  delegateToAgent: async (task, agentId, isLiveDelegation = false) => {
    broadcastLog(`[DELEGATION] Forwarding task to ${agentId.toUpperCase()}: ${task}`);
    try {
      if (agentId === 'claude') return await claudeWorker.handleCommand(task, 'voice', { isLiveDelegation });
      if (agentId === 'agy' || agentId === 'gemini' || agentId === 'antigravity') return await agyWorker.handleCommand(task, 'voice', { isLiveDelegation });
      if (agentId === 'nexus') return await agyWorker.handleCommand(`[Browser] ${task}`, 'voice', { isLiveDelegation }); 
      if (agentId === 'codex') return await runCodexTask(task);
      // fallback
      const result = await hermesWorker.runAgent(agentId, task, { isLiveDelegation });
      return result || `Task successfully delegated to local agent ${agentId.toUpperCase()}`;
    } catch(e) {
      return `Failed to delegate to ${agentId.toUpperCase()}: ${e.message}`;
    }
  },
  speak: speak
});
function handleGeminiCommand(command, source = 'text') {
  return agyWorker.handleCommand(command, source);
}

function handleClaudeCommand(command, source = 'text') {
  return claudeWorker.handleCommand(command, source);
}

/** A delegated task for the OpenAI Codex CLI (`codex exec -`, prompt on stdin); resolves with its answer. */
function runCodexTask(task) {
  return new Promise((resolve) => {
    const args = ['exec', '--skip-git-repo-check'];
    if (selectedModels.codex) args.push('-m', shellArg(selectedModels.codex));
    args.push('-');
    const proc = spawn(getCrossPlatformCommand('codex'), args, getSpawnOptions());
    activeProcesses.add(proc);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { activeProcesses.delete(proc); resolve(`Codex failed: ${e.message}`); });
    proc.on('close', (code) => {
      activeProcesses.delete(proc);
      const text = out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
      resolve(text || (code ? `Codex failed: ${err.trim().slice(-400) || `exit ${code}`}` : 'Done.'));
    });
    proc.stdin?.on('error', () => {});
    proc.stdin?.end(task + '\n');
  });
}

function spawnHermes(agentId, prompt, task) {
  return hermesWorker.spawnHermes(agentId, prompt, task);
}

function runHermesAgent(agentId, command) {
  return hermesWorker.runAgent(agentId, command);
}

async function handleOrchestration(command, source = 'text') {
  if (geminiLiveMode) {
    if (source === 'voice') return;
  }
  
  if (source === 'voice') {
    voiceAccumulator += (voiceAccumulator ? ' ' : '') + command;
    lastUserVoiceCommand = voiceAccumulator.trim();
    
    if (voiceDebounceTimer) clearTimeout(voiceDebounceTimer);
    voiceDebounceTimer = setTimeout(() => {
      const fullCommand = voiceAccumulator.trim();
      voiceAccumulator = '';
      if (fullCommand) conversationRuntime.handleInput(fullCommand, { source, language: activeLanguage, cancelAll: cancelActiveCommands });
    }, 1500);
    return;
  }
  
  await conversationRuntime.handleInput(command, { source, language: activeLanguage, cancelAll: cancelActiveCommands });
}

/**
 * Returns true when the user's command is purely an action/automation task
 * (open website, click, navigate, scroll, type, take screenshot, computer-use, etc.)
 * where the agent's textual reply is just a confirmation — not meaningful information
 * to display in the overlay.
 */
function isActionOnlyCommand(cmd) {
  const s = cmd.toLowerCase();
  const patterns = [
    // Browser / URL navigation
    /open\s+(https?:\/\/|www\.|the\s+browser|chrome|firefox|safari|edge|brave)/,
    /go\s+to\s+(https?:\/\/|www\.)/,
    /navigate\s+(to\s+)?(https?:\/\/|www\.)/,
    /visit\s+(https?:\/\/|www\.)/,
    /launch\s+(chrome|firefox|safari|edge|brave|the\s+browser)/,
    // Click / keyboard / mouse control
    /\b(click|double.?click|right.?click)\s+(on\s+)?(the\s+)?/,
    /\b(press|hit|type|input)\s+.{0,40}(enter|return|escape|tab|key)/,
    /\bscroll\s+(up|down|to)/,
    /\bdrag\s+.{0,20}\s+to\s+/,
    // Screenshots / recordings
    /\b(take\s+a?\s+screenshot|screen\s+capture|record\s+(my\s+)?(screen|display))/,
    // App control
    /\b(open|close|quit|minimize|maximize|focus|switch\s+to)\s+(the\s+)?(app|application|window|tab|program)/,
    // File system actions (open, move, delete — not read/analyze)
    /\b(open|move|rename|delete|trash|copy)\s+(the\s+)?(file|folder|directory)\s+/,
    // Terminal / shell commands executed silently
    /\b(run|execute|start|stop|restart|kill)\s+(the\s+)?(server|process|service|command|script|daemon)/,
  ];
  return patterns.some(p => p.test(s));
}

async function executeOrchestration(command, source = 'text') {
  if (isOrchestrating) cancelActiveCommands();
  
  if (source.startsWith('voice')) {
    const clean = command.trim().replace(/[.,!?;:'"]/g, '').toLowerCase();
    const words = clean.split(/\s+/).filter(Boolean);
    const FILLERS = new Set(['the','a','an','it','is','ok','okay','um','uh','hmm','yeah','yep','yes','no','so','and','or','but','well','right','sure','got','oh','hey','hi','this','that','i','me','my','we','just','like','know']);
    if (words.length === 1 && FILLERS.has(words[0])) return;
  }

  isOrchestrating = true;
  broadcastAgentStatus('jarvis', 'THINKING');
  broadcastAgentStatus(activeModel, 'THINKING');

  // A task never starts in silence: say who is on it, in the user's language (spoken when the
  // orb isn't on Gemini Live — that session speaks for itself).
  const ack = acknowledgement(activeModel, command, activeLanguage);
  broadcastLog(`JARVIS: ${ack}`);
  broadcast({ type: 'voice_transcript', text: ack, role: 'assistant', is_final: true });
  if (source.startsWith('voice') && !geminiLiveMode) speak(ack);
  
  const lowerCmd = command.toLowerCase();

  try {
    // Jarvis handles it directly
    let styleInstruction = "Keep your response conversational and natural.";
      if (source.startsWith('voice')) {
        styleInstruction = "The user spoke this via voice, and your response will be read aloud by Text-To-Speech. Keep your response brief, conversational, and completely free of markdown formatting (no asterisks, no bullet points). Use natural spoken English.";
      }
      
      const sysPrompt = `System instructions: You are JARVIS, an advanced AI assistant. Answer the user directly. ${styleInstruction}
You have full access to your tools. Use them to execute the user's command if needed.

User: ${command}`;
      
      broadcastAgentStatus('jarvis', 'WRITING');
      broadcastAgentStatus(activeModel, 'WRITING');
      
      let proc;
      let output = '';
      let stderrOutput = '';
      let speechBuffer = '';
      let isFirstChunk = true;
      
      if (activeModel === 'gemini') {
        const modelArgs = await agyArgs();
        // The prompt goes on stdin (as in AgyWorker): on Windows the CLI runs through
        // cmd.exe, which split `-p <prompt>` into words ("unexpected argument
        // 'instructions:'") and would run anything after a newline or `&` in user text.
        proc = spawn(getCrossPlatformCommand('agy'), ['--dangerously-skip-permissions', ...modelArgs], getSpawnOptions());
        proc.stdin?.on('error', () => {});
        proc.stdin?.end(sysPrompt + '\n');
      } else if (activeModel === 'codex') {
        // OpenAI Codex CLI: `codex exec -` reads the prompt from stdin.
        const args = ['exec', '--skip-git-repo-check'];
        if (selectedModels.codex) args.push('-m', shellArg(selectedModels.codex));
        args.push('-');
        proc = spawn(getCrossPlatformCommand('codex'), args, getSpawnOptions());
        proc.stdin?.on('error', () => {});
        proc.stdin?.end(sysPrompt + '\n');
      } else if (activeModel === 'claude') {
        proc = spawn(getCrossPlatformCommand('claude'), [
          '-y',
          '-p',
          '--output-format', 'text',
          '--model', shellArg(selectedModels.claude || 'claude-3-haiku-20240307'),
        ], getSpawnOptions());
        proc.stdin?.on('error', () => {});
        proc.stdin?.end(sysPrompt + '\n');
      } else {
        const hermes = splitHermesModel(selectedModels.hermes);
        const args = ['chat', '-q', shellArg(sysPrompt)];
        if (hermes.model) args.push('-m', shellArg(hermes.model));
        const sid = agentSessions.get('jarvis');
        if (sid) args.push('--resume', sid);
        if (hermes.provider) args.push('--provider', shellArg(hermes.provider));
        args.push('-Q');
        proc = spawn(HERMES_BIN, args, getSpawnOptions());
      }
      
      let didPerformTask = false;
      if (proc) {
        activeProcesses.add(proc);
        await new Promise((resolve, reject) => {
          proc.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;
            
            const lower = chunk.toLowerCase();
            if (lower.includes('computer_use') || lower.includes('vision') || lower.includes('mouse') || lower.includes('keyboard')) {
              broadcastAgentStatus('vision', 'WORKING', 'Controlling UI');
              didPerformTask = true;
            }
            if (lower.includes('terminal') || lower.includes('bash') || lower.includes('git') || lower.includes('exec')) {
              broadcastAgentStatus('stark', 'WORKING', 'Executing code');
              didPerformTask = true;
            }
            if (lower.includes('search') || lower.includes('browser') || lower.includes('web')) {
              broadcastAgentStatus('athena', 'WORKING', 'Researching');
              didPerformTask = true;
            }
            if (lower.includes('file') || lower.includes('read') || lower.includes('write')) {
              broadcastAgentStatus('veronica', 'WORKING', 'File system');
              didPerformTask = true;
            }
            
            const cleanChunk = chunk;
            if (cleanChunk) {
              const match = cleanChunk.match(/session_id:\s*([^\s]+)/);
              if (match) agentSessions.set('jarvis', match[1].trim());

              // Strip out any potential ANSI or session_id from the streaming token
              const strippedToken = cleanChunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/^session_id:.*$/gm, '');
              broadcast({ type: 'core_output_token', agentId: 'jarvis', token: strippedToken });
              speechBuffer += strippedToken;
              
              let splitMatch;
              while ((splitMatch = speechBuffer.match(/([.!?]+[\s\n]+)(.*)/))) {
                const sentence = speechBuffer.substring(0, splitMatch.index + splitMatch[1].length).trim();
                speechBuffer = splitMatch[2] || '';
                if (sentence) {
                  const cleanSentence = cleanHermesOutput(sentence).trim();
                  if (cleanSentence) {
                    speak(cleanSentence, { interrupt: isFirstChunk });
                    isFirstChunk = false;
                  }
                }
              }
            }
          });

          proc.stderr.on('data', (data) => {
            const line = data.toString().trim();
            if (line) {
              stderrOutput += (stderrOutput ? '\n' : '') + line;
              const match = line.match(/session_id:\s*([^\s]+)/);
              if (match) agentSessions.set('jarvis', match[1].trim());
              console.error(`[CLI STDERR] ${line}`);
            }
          });

          proc.on('close', (code) => {
            activeProcesses.delete(proc);
            ['vision', 'stark', 'athena', 'veronica', 'odin', 'ultron', 'friday', 'steve'].forEach(a => {
              broadcastAgentStatus(a, 'IDLE');
            });
            if (code !== 0 && !output.trim()) {
              reject(new Error(`Agent execution failed with exit code ${code}${stderrOutput ? `: ${stderrOutput}` : ''}`));
            } else {
              resolve();
            }
          });
          proc.on('error', reject);
        });
        
        broadcastAgentStatus('jarvis', 'IDLE');
        broadcastAgentStatus(activeModel, 'IDLE');
        const cleanOut = cleanHermesOutput(output).trim();
        if (cleanOut) {
          // For action-only commands (open website, click, navigate, computer-use etc.)
          // skip the overlay — just speak the confirmation and log silently.
          const actionOnly = isActionOnlyCommand(command);
          const hasArtifact = /\.(glb|gltf|obj|stl|fbx)(\?|$|\s|\))/i.test(cleanOut) || cleanOut.includes('/api/local-image') || cleanOut.includes('```');
          const isDelegated = didPerformTask || hasArtifact;

          if (actionOnly) {
            // Broadcast a lightweight action event (no overlay triggered)
            broadcast({ type: 'agent_action', agentId: 'jarvis', agentName: activeModel.toUpperCase(), result: cleanOut });
          } else if (isDelegated) {
            // Delegated execution task — show the overlay with rich UI cards
            broadcast({ type: 'agent_result', agentId: 'jarvis', agentName: activeModel.toUpperCase(), result: cleanOut, isDelegated: true });
          } else {
            // Conversational talk — do not trigger overlay
            broadcast({ type: 'agent_conversation', agentId: 'jarvis', agentName: activeModel.toUpperCase(), result: cleanOut, isDelegated: false });
            broadcast({ type: 'voice_transcript', text: cleanOut, role: 'assistant', is_final: true });
          }
          const cleanRemain = cleanHermesOutput(speechBuffer).trim();
          if (cleanRemain && source.startsWith('voice')) {
            speak(cleanRemain, { interrupt: isFirstChunk });
          }
          return cleanOut;
        }
        return "Task completed successfully.";
      }
      return "Agent failed to execute or did not return output.";
  } catch (e) {
    broadcastAlert(`JARVIS error: ${e.message}`);
    broadcastAgentStatus('jarvis', 'IDLE');
    return `Agent execution failed: ${e.message}`;
  } finally {
    isOrchestrating = false;
  }
}
// ── Telemetry ───────────────────────────────────────────────────────────────
async function getTelemetry() {
  const [cpu, mem] = await Promise.all([
    si.currentLoad(),
    si.mem(),
  ]);
  const ramUsed = Math.round((mem.used / mem.total) * 100);
  return {
    cpu: Math.round(cpu.currentLoad),
    ram: ramUsed,
  };
}

setInterval(async () => {
  try {
    const data = await getTelemetry();
    broadcast({ type: 'telemetry', data });
  } catch(e) {}
}, 3000);

// ── RSS News Feed ───────────────────────────────────────────────────────────
// Your news feeds (comma-separated RSS URLs): NEWS_RSS_URLS, or Settings → Integrations. None by default.
const parseFeeds = (spec) => String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).map((url) => ({ url, tag: 'NEWS' }));
let RSS_FEEDS = parseFeeds(process.env.NEWS_RSS_URLS);

let cachedFeed = [];

async function getFeedItems() {
  const results = [];
  await Promise.allSettled(RSS_FEEDS.map(async ({ url, tag }) => {
    try {
      const feed = await rssParser.parseURL(url);
      feed.items.slice(0, 4).forEach(item => {
        results.push({
          tag,
          title: item.title || '',
          source: feed.title || tag,
          time: item.isoDate ? new Date(item.isoDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--',
          link: item.link || '',
        });
      });
    } catch(e) {}
  }));
  results.sort(() => Math.random() - 0.5);
  return results.slice(0, 16);
}

async function refreshFeed() {
  try {
    cachedFeed = await getFeedItems();
    broadcast({ type: 'feed', items: cachedFeed });
  } catch(e) {}
}
refreshFeed();
setInterval(refreshFeed, 5 * 60 * 1000);

// ── Crypto Wallet ───────────────────────────────────────────────────────────
let cachedCrypto = null;

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function getCryptoData() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(CRYPTO_WALLET)) return null; // no wallet configured
  try {
    const TOKENS = [
      { symbol: 'ETH', name: 'Ethereum', address: null, decimals: 18, cgId: 'ethereum' },
      { symbol: 'USDC', name: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, cgId: 'usd-coin' },
      { symbol: 'DEGEN', name: 'Degen', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18, cgId: 'degen-base' },
      { symbol: 'AERO', name: 'Aerodrome', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18, cgId: 'aerodrome-finance' },
    ];

    const cgIds = TOKENS.map(t => t.cgId).join(',');
    const [pricesRes, ...balancesRes] = await Promise.all([
      fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd&include_24hr_change=true`),
      // Native ETH balance
      fetchWithTimeout('https://mainnet.base.org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [CRYPTO_WALLET, 'latest'], id: 1 }),
      }),
      // Token balances
      ...TOKENS.filter(t => t.address).map(t => 
        fetchWithTimeout('https://mainnet.base.org', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            jsonrpc: '2.0', 
            method: 'eth_call', 
            params: [{ to: t.address, data: '0x70a08231000000000000000000000000' + CRYPTO_WALLET.slice(2) }, 'latest'], 
            id: 1 
          }),
        })
      )
    ]);

    const pricesJson = await pricesRes.json();
    const nativeBalJson = await balancesRes[0].json();
    const tokenBalJsons = await Promise.all(balancesRes.slice(1).map(r => r.json()));

    let totalUsd = 0;
    const nativeBalance = Number(BigInt(nativeBalJson.result || '0x0')) / 1e18;
    totalUsd += nativeBalance * (pricesJson?.ethereum?.usd || 0);

    const tokenData = TOKENS.filter(t => t.address).map((t, i) => {
      const bal = Number(BigInt(tokenBalJsons[i].result || '0x0')) / Math.pow(10, t.decimals);
      const price = pricesJson?.[t.cgId]?.usd || 0;
      totalUsd += bal * price;
      return { ...t, balance: bal, price };
    });

    const ethPrice = pricesJson?.ethereum?.usd || 0;
    const ethChange = pricesJson?.ethereum?.usd_24h_change || 0;

    return {
      address: CRYPTO_WALLET,
      balanceBase: nativeBalance.toFixed(4),
      ethPrice: ethPrice.toFixed(2),
      ethChange: ethChange.toFixed(2),
      totalUsd: totalUsd.toFixed(2),
      network: 'BASE',
      tokens: tokenData
    };
  } catch(e) {
    console.error('Crypto error:', e.message);
    return cachedCrypto;
  }
}

async function refreshCrypto() {
  cachedCrypto = await getCryptoData();
  if (cachedCrypto) broadcast({ type: 'crypto', data: cachedCrypto });
}
refreshCrypto();
setInterval(refreshCrypto, 30 * 1000);

// ── Apple Health (file-based) ───────────────────────────────────────────────
async function getHealthData() {
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      const raw = fs.readFileSync(HEALTH_FILE, 'utf8');
      return { ...JSON.parse(raw), connected: true };
    }
  } catch(e) {}
  return { connected: false };
}
// ── Local Image Proxy ──────────────────────────────────────────────────────────
const localImageProxyHandler = (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);

  // Decode URI component safely
  let cleanPath = filePath;
  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch (e) {}

  // 1. If it starts with file://, use url.fileURLToPath or preserve leading slash
  if (/^file:\/\//i.test(cleanPath)) {
    try {
      cleanPath = fileURLToPath(cleanPath);
    } catch (e) {
      cleanPath = cleanPath.replace(/^file:\/\/(localhost)?/i, '');
      if (!/^[a-zA-Z]:/.test(cleanPath) && !cleanPath.startsWith('/')) {
        cleanPath = '/' + cleanPath;
      }
    }
  } else if (/^file:\/+/i.test(cleanPath)) {
    cleanPath = cleanPath.replace(/^file:\/+/i, '');
    if (!/^[a-zA-Z]:/.test(cleanPath) && !cleanPath.startsWith('/')) {
      cleanPath = '/' + cleanPath;
    }
  }

  // If Windows path has a leading slash (e.g. /C:/... or \C:\...), strip it
  if (/^[\/\\][a-zA-Z]:/.test(cleanPath)) {
    cleanPath = cleanPath.slice(1);
  }

  // Expand ~ to user home directory
  if (cleanPath.startsWith('~')) {
    cleanPath = cleanPath.replace(/^~(?=$|\/|\\)/, os.homedir());
  }

  // Normalize path using Node's path module
  cleanPath = path.normalize(cleanPath);

  // If on POSIX (macOS/Linux) and path doesn't start with / and isn't a Windows drive,
  // check if prepending / resolves to an existing file
  if (process.platform !== 'win32' && !cleanPath.startsWith('/') && !/^[a-zA-Z]:/.test(cleanPath)) {
    if (fs.existsSync('/' + cleanPath)) {
      cleanPath = '/' + cleanPath;
    }
  }

  // Robust path resolution with fallback searches
  let resolvedPath = path.resolve(cleanPath);
  if (!fs.existsSync(resolvedPath)) {
    if (fs.existsSync('/' + cleanPath)) {
      resolvedPath = '/' + cleanPath;
    } else if (fs.existsSync(path.resolve(os.homedir(), cleanPath))) {
      resolvedPath = path.resolve(os.homedir(), cleanPath);
    } else if (fs.existsSync(path.resolve(process.cwd(), cleanPath))) {
      resolvedPath = path.resolve(process.cwd(), cleanPath);
    } else if (fs.existsSync(path.resolve(process.cwd(), '..', cleanPath))) {
      resolvedPath = path.resolve(process.cwd(), '..', cleanPath);
    }
  }

  if (fs.existsSync(resolvedPath)) {
    const ext = resolvedPath.split('.').pop()?.toLowerCase();
    const mimeTypes = {
      'obj': 'text/plain; charset=utf-8',
      'glb': 'model/gltf-binary',
      'gltf': 'model/gltf+json',
      'stl': 'model/stl',
      'fbx': 'application/octet-stream',
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'mkv': 'video/x-matroska',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'ogg': 'audio/ogg',
      'm4a': 'audio/mp4',
      'aac': 'audio/aac',
      'flac': 'audio/flac',
      'pdf': 'application/pdf',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      'bmp': 'image/bmp',
      'txt': 'text/plain; charset=utf-8',
      'log': 'text/plain; charset=utf-8',
      'md': 'text/markdown; charset=utf-8',
      'json': 'application/json',
      'csv': 'text/csv; charset=utf-8',
    };

    if (ext && mimeTypes[ext]) {
      res.set('Content-Type', mimeTypes[ext]);
    }
    res.set('Accept-Ranges', 'bytes');

    res.sendFile(resolvedPath, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) {
        res.status(err.status || 500).json({ error: err.message });
      }
    });
  } else {
    res.status(404).json({ error: 'File not found', path: cleanPath, resolved: resolvedPath });
  }
};
app.get('/api/local-image', localImageProxyHandler);
app.get('/api/local-image/:filename', localImageProxyHandler);

app.get('/api/feed', async (req, res) => {
  try {
    if (!cachedFeed || cachedFeed.length === 0) {
      cachedFeed = await getFeedItems();
    }
    res.json({ items: cachedFeed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/crypto', async (req, res) => {
  try {
    if (!cachedCrypto) {
      cachedCrypto = await getCryptoData();
    }
    res.json({ data: cachedCrypto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/telemetry', async (req, res) => {
  try {
    const data = await getTelemetry();
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const { hostUrl, appLanguage, cryptoWallet, newsRssUrl } = req.body;
    // Where this server's avatar, LLMs and TTS live is the owner's call (it would redirect the
    // server's traffic for everyone).
    const isOwner = (req.headers['x-api-key'] || req.query.api_key) === process.env.API_KEY;
    const { llmServers, ttsServer, avatarServerUrl } = isOwner ? req.body : {};
    if (avatarServerUrl !== undefined && avatarServerUrl.trim() !== '') {
      global.AVATAR_SERVER_URL = avatarServerUrl.trim();
      configuredStreamerUrl = global.AVATAR_SERVER_URL;
    }
    if (llmServers !== undefined && llmServers.trim().length > 0) {
      OLLAMA_SERVERS = llmServers.split(',').map(s => s.trim()).filter(Boolean);
      activeGenerations = new Map(OLLAMA_SERVERS.map(url => [url, 0]));
    }
    if (ttsServer !== undefined) {
      global.TTS_SERVER = ttsServer; // Exported to TTSEngine.js
    }
    if (cryptoWallet !== undefined) CRYPTO_WALLET = cryptoWallet.trim();
    if (newsRssUrl !== undefined) RSS_FEEDS = parseFeeds(newsRssUrl);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agents installed on this server and their models (agents/detect.js), cached 10 min.
const detectAgents = createAgentDetector({ exec: execAsync });
// Warm the cache at startup, and default each agent to a model this server really has.
detectAgents().then(({ agents }) => {
  for (const a of agents) {
    if (a.driven && a.models.length && !a.models.includes(selectedModels[a.id])) selectedModels[a.id] = a.models[0];
  }
}).catch(() => {});

app.get('/api/agents', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1' && isAuthorized(req.headers['x-api-key'] || req.query.api_key);
    res.json(await detectAgents({ refresh }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Same shape as before ({ gemini: [...], claude: [...], hermes: [...] }), now detected:
// only agents installed here that Jarvis can drive.
app.get('/api/models', async (req, res) => {
  try {
    const { agents } = await detectAgents();
    res.json(Object.fromEntries(agents.filter((a) => a.driven).map((a) => [a.id, a.models])));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hardware + avatar-session status (system/serverStatus.js): GET /api/server/status.
const serverStatus = createStatusCollector({
  name: process.env.JARVIS_SERVER_NAME || os.hostname(),
  version: SERVER_VERSION,
  exec: execAsync,
  fetchStreamer: (p, opts) => fetchFromStreamer(p, opts),
  cpuLoadPct: async () => Math.round((await si.currentLoad()).currentLoad),
  // Windows servers run the streamer from streamer_win_env and the renderer in WSL.
  install: process.platform === 'win32' ? () => {
    const renderer = wslRoots().some((root) => { try { return fs.existsSync(path.win32.join(root, 'root', 'avtr-1')); } catch { return false; } });
    return { streamerEnv: fs.existsSync(path.resolve(__dirname, '../streamer_win_env/Scripts/python.exe')), wslDistro: wslDistro(), renderer };
  } : undefined,
  limits: {
    minFreeVramMB: Number(process.env.AVATAR_MIN_FREE_VRAM_MB || 4000),
    maxGpuUtilPct: Number(process.env.AVATAR_MAX_GPU_UTIL_PCT || 85),
  },
});

// Settings → Live avatar → Avatar server (the owner only: the avatar gets this server's key).
const isOwnerRequest = (req) => !!process.env.API_KEY && (req.headers['x-api-key'] || req.query.api_key) === process.env.API_KEY;

async function probeAvatarServer({ url, key }) {
  let error = `Can't reach ${url}`;
  for (const p of ['/session-status', '/avatars']) {
    try {
      const r = await fetch(`${url}${p}`, { headers: key ? { 'x-api-key': key } : {}, signal: AbortSignal.timeout(6000) });
      if (r.ok) return { reachable: true };
      if (r.status === 401 || r.status === 403) return { reachable: false, error: 'The avatar server refused the API key.' };
      error = `${url} answered HTTP ${r.status}`;
    } catch (e) {
      error = `Can't reach ${url}: ${e.cause?.code || e.message}`;
    }
  }
  return { reachable: false, error };
}

const avatarSourceView = () => {
  const s = avatarSource.get();
  return {
    computerName: process.env.JARVIS_SERVER_NAME || os.hostname().replace(/\.local$/, ''),
    mode: s.mode, url: s.url, hasKey: !!s.key, machine: false, cloudLinked: false,
    callbackUrl: s.mode === 'own' ? callbackUrl({ target: s.url, port, lan: lanAddress(), tunnelUrl: null, envUrl: process.env.JARVIS_BACKEND_URL }) : null,
  };
};

app.get('/api/avatar/source', async (req, res) => {
  if (!isOwnerRequest(req)) return res.status(403).json({ error: "Only this server's owner can see this" });
  // Your own server: say whether it answers right now (Settings shows "Connected").
  const s = avatarSource.get();
  const probe = s.mode === 'own' ? await probeAvatarServer(s) : {};
  res.json({ ...avatarSourceView(), ...probe });
});

app.post('/api/avatar/source', async (req, res) => {
  if (!isOwnerRequest(req)) return res.status(403).json({ error: "Only this server's owner can change the avatar server" });
  try {
    const prev = avatarSource.get();
    const body = req.body || {};
    const key = body.key === undefined || (body.key === '' && body.url === prev.url) ? prev.key : body.key;
    // mode "cloud" (the value the apps send) = this server's default streamer.
    const next = avatarSource.set({ ...body, key });
    rendererAvatarsCache = { at: 0, list: null };
    const probe = next.mode === 'own' ? await probeAvatarServer(next) : { reachable: true };
    broadcastLog(next.mode === 'own' ? `[LIVE AVATAR] Avatar server: ${next.url}` : '[LIVE AVATAR] Avatar server: default');
    res.json({ ...avatarSourceView(), ...probe });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/server/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(await serverStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/health/status', async (req, res) => {
  res.json(await getHealthData());
});

// ── Spotify Control (AppleScript) ──────────────────────────────────────────
async function spotifyScript(cmd) {
  const scripts = {
    play: `tell application "Spotify" to play`,
    pause: `tell application "Spotify" to pause`,
    next: `tell application "Spotify" to next track`,
    prev: `tell application "Spotify" to previous track`,
    state: `tell application "Spotify" to player state as string`,
    track: `tell application "Spotify" to name of current track`,
    artist: `tell application "Spotify" to artist of current track`,
    volume: null,
  };
  const script = scripts[cmd];
  if (!script) return null;
  const { stdout } = await execAsync(`osascript -e '${script}'`);
  return stdout.trim();
}

app.post('/api/spotify/:action', async (req, res) => {
  try {
    const { action } = req.params;
    if (action === 'volume') {
      const { value } = req.body;
      await execAsync(`osascript -e 'tell application "Spotify" to set sound volume to ${Math.round(value)}'`);
      return res.json({ ok: true });
    }
    const result = await spotifyScript(action);
    // After play/pause/next/prev, fetch current track info
    if (['play', 'pause', 'next', 'prev'].includes(action)) {
      await new Promise(r => setTimeout(r, 300));
      const [state, track, artist] = await Promise.all([
        spotifyScript('state'),
        spotifyScript('track'),
        spotifyScript('artist'),
      ]);
      const info = { state, track, artist };
      broadcast({ type: 'spotify', data: info });
      return res.json(info);
    }
    res.json({ result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/spotify/state', async (req, res) => {
  try {
    const [state, track, artist] = await Promise.all([
      spotifyScript('state'),
      spotifyScript('track'),
      spotifyScript('artist'),
    ]);
    res.json({ state, track, artist });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Rich result cards: real data behind them ─────────────────────────────────
registerCardRoutes(app);

// ── AVTR-1 renderer (WSL) ───────────────────────────────────────────────────
// The renderer runs in WSL, started by boot.bat. Twice after a full reboot it hung
// before serving (launcher log stuck at "Starting…"), leaving the avatar black, while
// restarting just the renderer worked every time — so the backend watches it.
async function restartRenderer(reason) {
  // Machines without the avatar stack have nothing to restart.
  if (!fs.existsSync(path.resolve(__dirname, '../streamer_win_env/Scripts/python.exe'))) return;
  broadcastLog(`[RENDERER] Restarting the AVTR-1 renderer (${reason})...`);
  // [a]vtr1 keeps pkill from matching its own bash -c command line.
  await execAsync(`wsl -d ${wslDistro()} -e bash -c "fuser -k 8000/tcp >/dev/null 2>&1; pkill -f '[a]vtr1_renderer'; sleep 3; pkill -9 -f '[a]vtr1_renderer'; true"`, { timeout: 40000 }).catch(() => {});
  // When the WSL process exits, the Windows launcher exits too and releases its log.
  setTimeout(() => execAsync('cd .. && start /B streamer_win_env\\Scripts\\python.exe run_renderer_wsl.py > live_avatar_renderer.log 2>&1'), 2000);
}

const RENDERER_CHECK_MS = 60_000;
const RENDERER_DOWN_CHECKS = 3; // a normal start takes well under a minute
let rendererDownChecks = 0;
async function checkRenderer() {
  try {
    const r = await fetchFromStreamer('/debug/latency', { signal: AbortSignal.timeout(8000) });
    const body = await r.json();
    if (body?.renderer?.error) rendererDownChecks += 1;
    else rendererDownChecks = 0;
  } catch {
    return; // the streamer itself is down or restarting: not the renderer's fault
  }
  if (rendererDownChecks >= RENDERER_DOWN_CHECKS) {
    rendererDownChecks = 0;
    broadcastNotification({ label: 'LIVE AVATAR', msg: 'Renderer not responding — restarting it', kind: 'warn' });
    await restartRenderer(`not responding for ${RENDERER_DOWN_CHECKS} minutes`);
  }
}
if (process.platform === 'win32') setInterval(checkRenderer, RENDERER_CHECK_MS);

// ── Quick Actions ───────────────────────────────────────────────────────────
app.post('/api/action/:name', async (req, res) => {
  const { name } = req.params;
  try {
    switch (name) {
      case 'flush-cache': {
        await fetch('http://localhost:11434/api/delete', { method: 'DELETE', body: JSON.stringify({ name: 'cache' }) }).catch(() => {});
        broadcastLog('[ACTION] Cache flush requested.');
        broadcastNotification({ label: 'QUICK ACTION', msg: 'Cache flush executed', kind: 'info' });
        return res.json({ ok: true, msg: 'Cache flush requested' });
      }
      case 'download-logs': {
        const reqFile = req.query.file || req.body?.file || 'backend.log';
        const allowed = ['backend.log', 'live_avatar.log', 'live_avatar_renderer.log', 'frontend.log', 'voice_server.log'];
        const target = allowed.includes(reqFile) ? reqFile : 'backend.log';
        const logPath = path.resolve('..', target);
        if (fs.existsSync(logPath)) return res.download(logPath, target);
        return res.status(404).json({ error: `Log ${target} not found` });
      }
      case 'sync-repo': {
        const { stdout } = await execAsync('git -C .. fetch origin main && git -C .. reset --hard origin/main 2>&1');
        broadcastLog(`[GIT] ${stdout.trim()}`);
        broadcastNotification({ label: 'GIT SYNC', msg: stdout.trim().substring(0, 80), kind: 'success' });
        
        // Bring the renderer's WSL copy (/root/avtr-1) up to date with git — same script as boot.bat.
        if (process.platform === 'win32') {
          const sync = await execAsync('..\\live_avatar\\sync_to_wsl.bat', { env: { ...process.env, JARVIS_WSL_DISTRO: wslDistro() }, timeout: 30 * 60_000 })
            .catch((e) => ({ stdout: e.stdout || e.message }));
          broadcastLog(`[WSL SYNC] ${String(sync.stdout || '').trim()}`);
        }

        return res.json({ ok: true, msg: stdout.trim() });
      }
      case 'wipe-terminal': {
        broadcast({ type: 'wipe_logs' });
        return res.json({ ok: true });
      }
      case 'reboot-nodes': {
        broadcastLog('[ACTION] Rebooting nodes in 3 seconds...');
        const rebootCmd = process.platform === 'win32' ? 'cd .. && start cmd /c boot.bat' : 'cd .. && bash boot.sh &';
        setTimeout(() => execAsync(rebootCmd), 3000);
        return res.json({ ok: true, msg: 'Rebooting...' });
      }
      case 'renderer-status': {
        // Read-only: GPU processes and Python processes inside WSL (who is on the GPU?).
        if (process.platform !== 'win32') return res.status(400).json({ error: 'The renderer runs in WSL on Windows' });
        const { stdout } = await execAsync(`wsl -d ${wslDistro()} -e bash -c "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv 2>&1; echo ---; ps -eo pid,ppid,etime,pcpu,rss,stat,args --sort=-pcpu | grep -E '[p]ython|[u]vicorn' | cut -c1-220; echo ---; for p in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do ps -o pid,etime,pcpu,args -p $p 2>/dev/null | tail -n +2 | cut -c1-200; done"`, { timeout: 30000 }).catch((e) => ({ stdout: e.message }));
        // Windows' own view names every process on the GPU (Parsec, browsers, games…).
        const win = await execAsync('nvidia-smi', { timeout: 20000 }).catch((e) => ({ stdout: e.message }));
        return res.json({ ok: true, msg: `${stdout}\n=== Windows nvidia-smi ===\n${win.stdout}` });
      }
      case 'restart-renderer': {
        if (process.platform !== 'win32') return res.status(400).json({ error: 'The renderer runs in WSL on Windows' });
        await restartRenderer('quick action');
        return res.json({ ok: true, msg: 'Renderer restart initiated (about a minute to load)' });
      }
      case 'restart-wsl': {
        // Clean slate for the GPU renderer: stop every WSL process, then boot.bat again.
        if (process.platform !== 'win32') return res.status(400).json({ error: 'WSL is Windows only' });
        broadcastLog('[ACTION] Shutting WSL down and rebooting Jarvis in 3 seconds...');
        setTimeout(() => execAsync('cd .. && start "" cmd /c restart_wsl.bat'), 3000);
        return res.json({ ok: true, msg: 'WSL shutdown + reboot initiated' });
      }
      case 'restart-parsec': {
        if (process.platform !== 'win32') return res.status(400).json({ error: 'Parsec restart is Windows only' });
        broadcastLog('[ACTION] Restarting Parsec...');
        // Stop parsecd: the Parsec service relaunches it (restarting the service itself
        // needs admin rights the backend doesn't have); start it ourselves if it doesn't.
        const script = [
          "$old = Get-Process parsecd -ErrorAction SilentlyContinue | Select-Object -First 1",
          "$exe = if ($old) { $old.Path } else { $null }",
          "if (-not $exe) { foreach ($c in @(\"$env:ProgramFiles\\Parsec\\parsecd.exe\", \"$env:APPDATA\\Parsec\\parsecd.exe\")) { if (Test-Path $c) { $exe = $c; break } } }",
          "if ($old) { try { Stop-Process -Id $old.Id -Force -ErrorAction Stop } catch { Write-Output \"stop failed: $($_.Exception.Message)\" } }",
          "Start-Sleep -Seconds 5",
          "$new = Get-Process parsecd -ErrorAction SilentlyContinue | Select-Object -First 1",
          "if (-not $new -and $exe) { Start-Process $exe; Start-Sleep -Seconds 3; $new = Get-Process parsecd -ErrorAction SilentlyContinue | Select-Object -First 1 }",
          "Write-Output (\"parsecd pid {0} -> {1} ({2})\" -f $(if ($old) { $old.Id } else { 'none' }), $(if ($new) { $new.Id } else { 'none' }), $exe)",
        ].join('\n');
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, { timeout: 60000 }).catch((e) => ({ stdout: e.message }));
        return res.json({ ok: true, msg: String(stdout).trim() });
      }
      case 'restart-avatar': {
        broadcastLog('[ACTION] Restarting Live Avatar streamer on port 7860...');
        if (process.platform === 'win32') {
          await execAsync('powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 7860 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"').catch(() => {});
          const startStreamer = 'cd .. && start /B streamer_win_env\\Scripts\\python.exe live_avatar\\run_streamer_windows.py > live_avatar.log 2>&1';
          setTimeout(() => execAsync(startStreamer), 1500);
        } else {
          await execAsync('pkill -f run_streamer || true').catch(() => {});
        }
        return res.json({ ok: true, msg: 'Live Avatar streamer restart initiated' });
      }
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gemini Live API Integration ─────────────────────────────────────────────
async function syncGeminiLiveState() {
  const shouldConnect = geminiLiveMode;
  
  if (shouldConnect) {
    geminiLiveProvider.connect(activeModel);
  } else {
    geminiLiveProvider.disconnect();
  }
}

// ── Start ───────────────────────────────────────────────────────────────────
server.listen(port, () => {
  console.log(`JARVIS Backend Online on port ${port}`);
});
