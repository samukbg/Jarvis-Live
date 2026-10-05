# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Hybrid Neural Voice Synthesizer for live streaming avatars."""

import asyncio, io, os, re, json, sys, subprocess, time, urllib.request
from collections.abc import AsyncIterator
import av, httpx, numpy as np
from avaturn_live_streamer.wsl_distro import wsl_distro
try:
    import edge_tts
except ImportError:
    edge_tts = None

from avaturn_live_streamer.core.logs import get_logger
from avaturn_live_streamer.speech.speech_buffer import SpeechBuffer
from avaturn_live_streamer.speech.voice_converter import VoiceConverter

_LOGGER = get_logger()
_CHUNK_SAMPLES = 480
# XTTS (on the CPU by default) can take several seconds for a long sentence; a
# shorter timeout silently swaps the cloned voice for the EdgeTTS fallback.
_XTTS_TIMEOUT_S = 20.0

# WSL2 renderer URLs discovered via ``wsl.exe`` (computed at most once per process).
_WSL_DISCOVERY_CACHE: list[str] | None = None


def _discover_wsl_renderer_urls() -> list[str]:
    global _WSL_DISCOVERY_CACHE
    if _WSL_DISCOVERY_CACHE is None:
        urls: list[str] = []
        try:
            res = subprocess.run(["wsl.exe", "-d", wsl_distro(), "-e", "hostname", "-I"], capture_output=True, text=True, timeout=1.5)
            # Filter out Docker 172.17.x bridge networks
            urls = [
                f"http://{ip}:8000"
                for ip in res.stdout.strip().split()
                if not ip.startswith("172.17.") and not ip.startswith("127.")
            ]
        except Exception:
            pass
        _WSL_DISCOVERY_CACHE = urls
    return _WSL_DISCOVERY_CACHE


def _voice_server() -> tuple[str, dict[str, str]] | None:
    """XTTS_URL: a voice server on another GPU (another machine's Jarvis backend, which forwards to
    live_avatar/voice_server). One RTX 3090 can't render the 25 fps avatar and run XTTS in
    real time — each slowed the other — so the voice can live on a second machine."""
    url = (os.environ.get("XTTS_URL") or "").rstrip("/")
    if not url:
        return None
    key = os.environ.get("XTTS_API_KEY") or os.environ.get("API_KEY") or ""
    return url, ({"x-api-key": key} if key else {})


def _local_voice_server() -> str:
    """This machine's own voice server (live_avatar/voice_server, started by boot.bat when
    installed): XTTS on the same GPU, for a renderer without XTTS."""
    return f"http://127.0.0.1:{os.environ.get('VOICE_SERVER_PORT', '8010')}"


def _get_candidate_renderer_urls(preferred_url: str | None = None) -> list[str]:
    candidates = []
    # 1. Environment RENDERER_URL (verified by run_streamer_windows.py)
    env_url = (os.environ.get("RENDERER_URL") or "").rstrip("/")
    if env_url:
        candidates.append(env_url)
    if preferred_url:
        candidates.append(preferred_url.rstrip("/"))
    # 2. Dynamic WSL2 discovery, only when no URL is configured. Spawning wsl.exe
    # per sentence blocked the streamer's event loop (and its frame sender).
    if sys.platform == "win32" and not env_url:
        candidates.extend(_discover_wsl_renderer_urls())
    # Deduplicate preserving order
    seen = set()
    result = []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            result.append(c)
    return result


def detect_language(text: str) -> str:
    """XTTS needs the language: pt / fr / en from accents and common words."""
    t_low = text.lower()
    words = set(re.findall(r"\w+", t_low))
    fr_words = {'bonjour', 'salut', 'merci', 'oui', 'non', 'comment', 'suis', 'pour', 'avec', 'vous', 'nous', 'est', 'que', 'très', 'tres', 'faire', 'bien', 'ravie', 'ravi', 'voici', 'cette'}
    pt_words = {'olá', 'ola', 'você', 'voce', 'obrigado', 'obrigada', 'bom', 'boa', 'tudo', 'sim', 'não', 'nao', 'estou', 'como', 'para', 'uma', 'com', 'está', 'esta'}
    if any(c in 'ãõáíóú' for c in t_low) or bool(words.intersection(pt_words)):
        return "pt"
    if any(c in 'éèêëàâùûîïô' for c in t_low) or bool(words.intersection(fr_words)):
        return "fr"
    return "en"


# Streaming voice servers that failed recently (url → when): skipped for a while instead
# of costing a failed request per phrase.
_STREAM_DOWN: dict[str, float] = {}
_STREAM_RETRY_S = 120.0
_HTTP: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _HTTP
    if _HTTP is None:  # one keep-alive pool: no TCP/TLS handshake per phrase
        _HTTP = httpx.AsyncClient(timeout=httpx.Timeout(_XTTS_TIMEOUT_S, connect=2.0))
    return _HTTP


def _stream_candidates() -> list[tuple[str, dict[str, str]]]:
    """Voice servers that stream (POST /api/voice/stream): XTTS_URL's, then this machine's."""
    out = []
    if remote := _voice_server():
        out.append(remote)
    out.append((_local_voice_server(), {}))
    now = time.monotonic()
    return [c for c in out if now - _STREAM_DOWN.get(c[0], -1e9) > _STREAM_RETRY_S]


class HybridVoiceSynthesizer:
    def __init__(self, avatar_id: str = "maria", renderer_url: str | None = None):
        self.avatar_id = avatar_id.lower()
        self.renderer_url = renderer_url or os.environ.get("RENDERER_URL", "http://127.0.0.1:8000")
        self.converter = VoiceConverter(self.avatar_id)

    async def stream(self, text: str) -> AsyncIterator[SpeechBuffer]:
        """The cloned voice for `text`, in 20 ms chunks as soon as XTTS generates them.

        Streaming voice server first (first audio ~0.2-0.4 s after the text, instead of
        after the whole phrase); else the whole-phrase path (renderer XTTS, EdgeTTS).
        """
        text = text.strip()
        if not text:
            return
        payload = {"text": text, "avatar_id": self.avatar_id, "language": detect_language(text)}
        for base_url, headers in _stream_candidates():
            sent = False
            rest = b""
            try:
                async with _http().stream("POST", f"{base_url}/api/voice/stream", json=payload, headers=headers) as rsp:
                    if rsp.status_code != 200:
                        raise RuntimeError(f"HTTP {rsp.status_code}")
                    async for piece in rsp.aiter_bytes():
                        data = rest + piece
                        whole = len(data) - len(data) % (_CHUNK_SAMPLES * 2)
                        rest = data[whole:]
                        samples = np.frombuffer(data[:whole], dtype=np.int16)
                        for i in range(0, len(samples), _CHUNK_SAMPLES):
                            sent = True
                            yield SpeechBuffer(samples[i : i + _CHUNK_SAMPLES].copy(), 24000)
                if len(rest) >= 2:
                    sent = True
                    yield SpeechBuffer(np.frombuffer(rest[: len(rest) - len(rest) % 2], dtype=np.int16).copy(), 24000)
                if sent:
                    return
            except Exception as exc:
                if sent:  # cut mid-phrase: don't say it twice
                    _LOGGER.warning("Cloned voice stream cut", url=base_url, error=str(exc))
                    return
                _STREAM_DOWN[base_url] = time.monotonic()
                _LOGGER.info("Streaming voice server unavailable, trying the next", url=base_url, error=str(exc))
        for chunk in await self.synthesize_stream(text):
            yield chunk

    async def synthesize_stream(self, text: str) -> list[SpeechBuffer]:
        text = text.strip()
        if not text:
            return []
            
        lang = detect_language(text)

        # 1. Primary: High-Fidelity Neural Voice Cloning on RTX 3090 GPU (WSL2 XTTS-v2)
        # The dedicated voice server first (if configured), then the local renderer.
        # Then this machine's own voice server, for a renderer without XTTS. Both share
        # this GPU, so the reply is still played whole (gemini_client: no XTTS_URL).
        candidates: list[tuple[str, dict[str, str]]] = []
        if remote := _voice_server():
            candidates.append(remote)
        candidates += [(u, {}) for u in _get_candidate_renderer_urls(self.renderer_url)]
        candidates.append((_local_voice_server(), {}))
        payload = json.dumps({"text": text, "avatar_id": self.avatar_id, "language": lang}).encode("utf-8")

        for base_url, extra_headers in candidates:
            if time.monotonic() - _STREAM_DOWN.get(f"whole:{base_url}", -1e9) < _STREAM_RETRY_S:
                continue  # failed a moment ago (e.g. a renderer without XTTS answers 503)
            try:
                url = f"{base_url.rstrip('/')}/api/voice/synthesize"
                def _post(url=url, extra_headers=extra_headers):
                    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json", **extra_headers})
                    with urllib.request.urlopen(req, timeout=_XTTS_TIMEOUT_S) as resp:
                        return resp.read()
                        
                pcm_bytes = await asyncio.to_thread(_post)
                if pcm_bytes and len(pcm_bytes) >= 512:
                    samples = np.frombuffer(pcm_bytes, dtype=np.int16)
                    chunks = [SpeechBuffer(samples[i : i + _CHUNK_SAMPLES], 24000) for i in range(0, len(samples), _CHUNK_SAMPLES)]
                    if not extra_headers and base_url != _local_voice_server():
                        self.renderer_url = base_url
                    _LOGGER.info("Synthesized cloned voice via XTTS-v2", url=base_url, text=text[:40], samples=len(samples), chunks=len(chunks))
                    return chunks
            except Exception as exc:
                _STREAM_DOWN[f"whole:{base_url}"] = time.monotonic()
                _LOGGER.debug("GPU XTTS-v2 attempt failed on URL", url=base_url, error=str(exc))
                continue

        # 2. Resilient Fallback: Edge-TTS Multilingual with VoiceConverter reference timbre transfer
        if edge_tts is not None:
            try:
                if lang == "pt":
                    voice = "pt-BR-ThalitaMultilingualNeural"
                elif lang == "fr":
                    voice = "fr-FR-VivienneMultilingualNeural"
                else:
                    voice = "en-US-EmmaMultilingualNeural"

                communicate = edge_tts.Communicate(text, voice, pitch="-1Hz", rate="+1%")
                audio_bytes = bytearray()
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        audio_bytes.extend(chunk["data"])
                if audio_bytes and av is not None:
                    container = av.open(io.BytesIO(audio_bytes))
                    samples_list = []
                    resampler = av.AudioResampler(format="s16", layout="mono", rate=24000)
                    for frame in container.decode(audio=0):
                        for rf in resampler.resample(frame):
                            samples_list.append(rf.to_ndarray().reshape(-1))
                    if samples_list:
                        raw_pcm = np.concatenate(samples_list).astype(np.int16)
                        buf = SpeechBuffer(raw_pcm, 24000)
                        converted = self.converter.process_chunk(buf)
                        converted_samples = converted._buffer
                        chunks = [SpeechBuffer(converted_samples[i : i + _CHUNK_SAMPLES], 24000) for i in range(0, len(converted_samples), _CHUNK_SAMPLES)]
                        _LOGGER.info("Synthesized the voice via EdgeTTS fallback + VoiceConverter", text=text[:40], chunks=len(chunks))
                        return chunks
            except Exception as e:
                _LOGGER.warning("EdgeTTS fallback synthesis failed", error=str(e))

        return []
