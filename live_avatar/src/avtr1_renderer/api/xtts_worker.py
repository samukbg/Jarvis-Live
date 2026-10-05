# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Coqui XTTS-v2 voice cloning in its own process, on the GPU by default (XTTS_DEVICE).

XTTS used to run on a thread inside the renderer. Its Python-heavy GPT decoding held
the GIL for seconds per sentence, so the frame-rendering loop starved exactly when
the avatar started to talk: video froze and the audio track stopped, and the phone
had to conceal (invent) up to a third of the speech. In a separate process the
renderer keeps its interpreter to itself; both still share the RTX 3090.

Everything here runs in the worker process. The parent talks to it through
``XttsProcess`` (picklable arguments and results only, no HTTPException).
"""

from __future__ import annotations

import contextlib
import logging
import multiprocessing
import os
import time
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from typing import Any

import numpy as np

LOG = logging.getLogger(__name__)

REFERENCE_VOICE_DIRS = (
    Path("/root/avtr-1/reference_voices"),
    Path.cwd() / "reference_voices",
    Path.cwd() / "live_avatar" / "reference_voices",
)
_MODEL_DIRS = (
    *([Path(os.environ["XTTS_MODEL_DIR"])] if os.environ.get("XTTS_MODEL_DIR") else []),
    # Where Coqui downloads it on Windows (live_avatar/voice_server/setup_voice_server.bat).
    Path(os.environ.get("LOCALAPPDATA", "/nonexistent")) / "tts" / "tts_models--multilingual--multi-dataset--xtts_v2",
    Path("/root/avtr-1/models/xtts"),
    Path("/root/.local/share/tts/tts_models--multilingual--multi-dataset--xtts_v2"),
    Path.cwd() / "models" / "xtts",
    Path.cwd() / "live_avatar" / "models" / "xtts",
)


class XttsUnavailableError(RuntimeError):
    """The model failed to load (maps to HTTP 503)."""


class SpeakerNotFoundError(LookupError):
    """No reference voice / latents for this avatar (maps to HTTP 404)."""


# ── Worker-process state ─────────────────────────────────────────────────────
_model: Any = None
_latents: dict[str, dict[str, Any]] = {}


def _device() -> str:
    """XTTS_DEVICE=cuda (default) or cpu.

    XTTS and the face renderer share the RTX 3090: synthesising while the avatar speaks
    slows rendering below real time (~430 ms per 200 ms chunk) and the phone hears noise.
    The streamer therefore synthesises a whole reply before the avatar speaks (gemini
    client _tts_worker). On the CPU, XTTS is 1.5-2.5x slower than speech, so long
    sentences timed out and fell back to a crackly substitute voice (2026-10-01).
    """
    if os.environ.get("XTTS_DEVICE", "cuda").strip().lower() == "cpu":
        return "cpu"
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def _load_model() -> Any:
    global _model
    if _model is not None:
        return _model
    from TTS.tts.configs.xtts_config import XttsConfig
    from TTS.tts.models.xtts import Xtts

    model_dir = next((p for p in _MODEL_DIRS if (p / "config.json").is_file()), None)
    if model_dir is None:
        raise XttsUnavailableError("XTTS-v2 model directory not found")
    config = XttsConfig()
    config.load_json(str(model_dir / "config.json"))
    model = Xtts.init_from_config(config)
    model.load_checkpoint(config, checkpoint_dir=str(model_dir), use_deepspeed=False)
    if _device() == "cuda":
        model.cuda()
    _model = model
    LOG.info("XTTS-v2 loaded in worker pid %d", os.getpid())
    return _model


def _extract(avatar_id: str, audio_path: Path) -> dict[str, Any]:
    model = _load_model()
    gpt_cond_latent, speaker_embedding = model.get_conditioning_latents(audio_path=str(audio_path))
    device = _device()
    cached = {"gpt_cond_latent": gpt_cond_latent.to(device), "speaker_embedding": speaker_embedding.to(device)}
    _latents[avatar_id] = cached
    import torch

    torch.save(cached, audio_path.parent / f"{avatar_id}_latents.pt")
    LOG.info("XTTS latents extracted for '%s'", avatar_id)
    return cached


def _speaker(avatar_id: str) -> dict[str, Any]:
    if avatar_id in _latents:
        return _latents[avatar_id]
    for d in REFERENCE_VOICE_DIRS:
        for ext in (".ogg", ".wav"):
            p = d / f"{avatar_id}{ext}"
            if p.is_file():
                return _extract(avatar_id, p)
    raise SpeakerNotFoundError(f"No speaker latents found for avatar '{avatar_id}'")


def init_worker() -> None:
    """Process initializer: keep the CPU for the renderer, then load model + cached latents."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s xtts-worker: %(message)s")
    with contextlib.suppress(OSError, AttributeError):  # no os.nice on Windows
        os.nice(5)
    try:
        import torch

        cores = os.cpu_count() or 4
        # On the CPU, XTTS gets half the cores (the renderer's work is on the GPU);
        # on the GPU it needs few CPU threads.
        torch.set_num_threads(max(4, cores // 2) if _device() == "cpu" else max(1, min(4, cores // 4)))
        _load_model()
        for d in REFERENCE_VOICE_DIRS:
            if not d.is_dir():
                continue
            for p in d.glob("*_latents.pt"):
                av_id = p.stem.removesuffix("_latents")
                if av_id not in _latents:
                    try:
                        _latents[av_id] = torch.load(p, map_location=_device())
                    except Exception as exc:  # corrupt cache file: re-extract on demand
                        LOG.warning("Could not load %s: %s", p, exc)
            for p in d.glob("*.ogg"):
                if p.stem not in _latents:
                    try:
                        _extract(p.stem, p)
                    except Exception as exc:
                        LOG.warning("Could not extract latents for %s: %s", p.stem, exc)
        LOG.info("XTTS worker ready: %s", ", ".join(sorted(_latents)) or "no voices")
    except Exception as exc:
        # Keep the worker alive: synthesize() reports XttsUnavailableError per request.
        LOG.warning("XTTS worker init failed: %s", exc)


def to_pcm16(wav: Any) -> bytes:
    """Float waveform in [-1, 1] → little-endian int16 PCM, clipped."""
    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    samples = np.clip(np.asarray(wav, dtype=np.float32) * 32767.0, -32768, 32767).astype("<i2")
    return samples.tobytes()


def synthesize(avatar_id: str, text: str, lang: str) -> tuple[bytes, float]:
    """Returns (int16 PCM @ 24 kHz, inference ms)."""
    try:
        model = _load_model()
    except XttsUnavailableError:
        raise
    except Exception as exc:
        raise XttsUnavailableError(str(exc)) from exc
    speaker = _speaker(avatar_id)
    import torch

    t0 = time.perf_counter()
    # fp16 (autocast) roughly halves XTTS's GPU time, so it fits in what the face renderer
    # leaves free while the avatar speaks. XTTS_FP16=0 turns it off.
    half = _device() == "cuda" and os.environ.get("XTTS_FP16", "1") != "0"
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.float16, enabled=half):
        out = model.inference(
            text=text,
            language=lang,
            gpt_cond_latent=speaker["gpt_cond_latent"],
            speaker_embedding=speaker["speaker_embedding"],
            temperature=0.7,
            speed=1.05,
        )
    return to_pcm16(out["wav"]), (time.perf_counter() - t0) * 1000.0


def synthesize_stream(avatar_id: str, text: str, lang: str, should_stop: Callable[[], bool] = lambda: False):
    """Yields int16 PCM @ 24 kHz pieces as XTTS generates them (inference_stream).

    The first piece comes after ~XTTS_STREAM_CHUNK GPT tokens instead of after the whole
    sentence, so the avatar starts speaking a phrase a few hundred ms after its text exists.
    """
    model = _load_model()
    speaker = _speaker(avatar_id)
    import torch

    half = _device() == "cuda" and os.environ.get("XTTS_FP16", "1") != "0"
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.float16, enabled=half):
        for chunk in model.inference_stream(
            text=text,
            language=lang,
            gpt_cond_latent=speaker["gpt_cond_latent"],
            speaker_embedding=speaker["speaker_embedding"],
            stream_chunk_size=int(os.environ.get("XTTS_STREAM_CHUNK", "20")),
            temperature=0.7,
            speed=1.05,
            enable_text_splitting=False,
        ):
            if should_stop():
                return
            yield to_pcm16(chunk)


def extract_latents(avatar_id: str, audio_path: str) -> bool:
    try:
        _extract(avatar_id, Path(audio_path))
        return True
    except Exception as exc:
        LOG.warning("Failed extracting XTTS latents for '%s': %s", avatar_id, exc)
        return False


def has_speaker(avatar_id: str) -> bool:
    return avatar_id in _latents


def ping() -> int:
    return os.getpid()


# ── Parent side ──────────────────────────────────────────────────────────────
class XttsProcess:
    """One spawned XTTS worker. Calls are serialised; a crashed worker is replaced once."""

    def __init__(self, initializer: Callable[[], None] | None = init_worker) -> None:
        self._initializer = initializer
        self._pool: ProcessPoolExecutor | None = None

    def _executor(self) -> ProcessPoolExecutor:
        if self._pool is None:
            # spawn: a forked child would inherit the renderer's CUDA context.
            self._pool = ProcessPoolExecutor(
                max_workers=1,
                mp_context=multiprocessing.get_context("spawn"),
                initializer=self._initializer,
            )
        return self._pool

    async def call(self, fn: Callable[..., Any], *args: Any) -> Any:
        import asyncio

        loop = asyncio.get_running_loop()
        for attempt in (1, 2):
            try:
                return await loop.run_in_executor(self._executor(), fn, *args)
            except BrokenProcessPool:
                LOG.warning("XTTS worker died (attempt %d); starting a new one", attempt)
                self.shutdown()
                if attempt == 2:
                    raise
        raise AssertionError("unreachable")

    def start(self) -> None:
        """Spawn the worker now so the model is warm before the first sentence."""
        self._executor().submit(ping)

    def shutdown(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None
