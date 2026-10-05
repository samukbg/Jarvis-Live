# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: LicenseRef-AVTR-1-Community

"""FastAPI HTTP front-end for ``Pipeline.process_chunk``.

One streaming endpoint plus health. Avatars are loaded at startup by
scanning the ``reference_frames`` artifact directory.

The response body is the new safetensors state blob first, followed by
rendered frames concatenated. ``X-State-Length-Bytes`` gives the state-blob
length so the client can split the body without buffering the whole response.

Audio format: raw int16 PCM at 16 kHz mono (same convention as the old
renderer). The server converts to float32 [-1, 1] internally before
constructing the ``Chunk``.

Run locally::

    AVTR1_LOCAL_STORAGE=/var/lib/avtr1/artifacts \\
    pixi run python -m avtr1_renderer.api.app
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import numpy as np
import uvicorn
from anyio.streams.memory import MemoryObjectSendStream
from fastapi import FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from avaturn_live_streamer.utils.latency_probe import PROBE
from avtr1_renderer.api import xtts_worker
from avtr1_renderer.api.load_balancing import keep_alive_worker
from avtr1_renderer.avtr1_motion_generator import state_from_safetensors, state_to_safetensors
from avtr1_renderer.components.pixel_format import PixelFormat, get_bytes_per_frame
from avtr1_renderer.pipeline import TRANSPARENT_BG_ID, Pipeline
from avtr1_renderer.types import Chunk, RenderOptions
from avtr1_renderer.utils.asyncio import run_in_thread
from avtr1_renderer.utils.cuda_health import CudaHealthChecker

LOG = logging.getLogger(__name__)

_INT16_MAX = 32768.0


def _bytes_to_float32(buf: bytes, expected_samples: int, field: str) -> np.ndarray:
    expected_bytes = expected_samples * 2
    if len(buf) != expected_bytes:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{field}: expected exactly {expected_bytes} bytes "
                f"({expected_samples} int16 samples), got {len(buf)} bytes"
            ),
        )
    return np.frombuffer(buf, dtype=np.int16).astype(np.float32) / _INT16_MAX


def _build_chunk(
    audio_bytes: tuple[bytes, bytes, bytes, bytes],
    cur_n: int,
    fut_n: int,
) -> Chunk:
    cur, fut, curl, futl = audio_bytes
    speech = np.concatenate([
        _bytes_to_float32(cur, cur_n, "speech_current"),
        _bytes_to_float32(fut, fut_n, "speech_future"),
    ])
    listen = np.concatenate([
        _bytes_to_float32(curl, cur_n, "listen_current"),
        _bytes_to_float32(futl, fut_n, "listen_future"),
    ])
    return Chunk(audio_speech=speech, audio_listen=listen)


def run_chunk(
    loop: asyncio.AbstractEventLoop,
    state_fut: asyncio.Future[bytes],
    send: MemoryObjectSendStream[bytes],
    pipeline: Pipeline,
    avatar,
    audio_bytes: tuple[bytes, bytes, bytes, bytes],
    state_blob_in: bytes | None,
    options: RenderOptions,
    cur_n: int,
    fut_n: int,
) -> None:
    """Drive one chunk end-to-end on a worker thread."""
    t0 = time.perf_counter()
    try:
        chunk = _build_chunk(audio_bytes, cur_n, fut_n)
        if state_blob_in is not None:
            try:
                with PROBE.timed("render.state_decode_ms"):
                    prev_state = state_from_safetensors(state_blob_in, device="cuda")
            except Exception as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"failed to decode state safetensors blob: {exc}",
                ) from exc
        else:
            prev_state = None

        with PROBE.timed("render.to_state_ms"):
            next_state, frames_iter = pipeline.process_chunk(avatar, chunk, prev_state, options)
            state_blob_out = state_to_safetensors(next_state)
        loop.call_soon_threadsafe(state_fut.set_result, state_blob_out)

        with PROBE.timed("render.frames_ms"):
            for f in frames_iter:
                loop.call_soon_threadsafe(send.send_nowait, f.data.tobytes())
        PROBE.record("render.chunk_total_ms", (time.perf_counter() - t0) * 1000.0)

    except BaseException as exc:
        if not state_fut.done():
            loop.call_soon_threadsafe(state_fut.set_exception, exc)
        else:
            LOG.exception("post-state worker failure; closing connection")
    finally:
        loop.call_soon_threadsafe(send.close)


# ── Zero-Shot Neural Voice Cloning (Coqui XTTS-v2 on RTX 3090) ───────────────
# XTTS runs in its own process (see xtts_worker): on a thread it held the GIL for
# seconds per sentence and stalled frame rendering whenever the avatar began to talk.
_XTTS = xtts_worker.XttsProcess()


@asynccontextmanager
async def lifespan(app: FastAPI):
    t0 = time.monotonic()

    # Auto-discover all portrait PNGs in reference_frames.
    from avtr1_renderer.avtr1_artifact_manager import get_artifact_manager
    mgr = get_artifact_manager()
    portraits_dir = Path(mgr.get_artifact_path("reference_frames"))
    avatar_ids = [p.stem for p in sorted(portraits_dir.glob("*.png"))]
    if not avatar_ids:
        raise RuntimeError(f"No avatar PNGs found in {portraits_dir}")

    pipeline, registry = Pipeline.from_artifacts(
        avatar_ids=avatar_ids,
        portraits_dir=portraits_dir,
    )
    LOG.info("Avatars: %s", ", ".join(sorted(registry)))
    LOG.info(
        "Loaded engines + %d avatars + %d backgrounds in %.1fs",
        len(registry),
        len(pipeline._backgrounds),
        time.monotonic() - t0,
    )
    app.state.pipeline = pipeline
    app.state.registry = registry
    mg = pipeline._motion_generator
    app.state.current_samples = mg.chunk_size * mg.frame_len
    app.state.future_samples = mg.future_size * mg.frame_len + mg.audio_shift
    app.state.health = CudaHealthChecker()

    # Spawn the XTTS worker now: it loads the model and the cached speaker latents
    # in parallel with the first sessions instead of on the first sentence.
    _XTTS.start()

    try:
        async with keep_alive_worker():
            yield
    finally:
        _XTTS.shutdown()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/process-audio-v3")
async def process_audio_v3(
    request: Request,
    current_chunk: UploadFile,
    future_chunk: UploadFile,
    current_chunk_listen: UploadFile,
    future_chunk_listen: UploadFile,
    state: UploadFile | None = None,
    avatar_id: str = "anya_03_studio",
    bg_id: str = Query(..., description="Background id; must match an entry from /avatars"),
    pixel_format: PixelFormat = "yuv_i420",
    cfg_self_audio: float = 2.0,
    cfg_other_audio: float = 2.0,
    cfg_kp: float = 4.0,
    noise_alpha: float = 2.0,
    noise_trunc_z: float = 1.2,
) -> StreamingResponse:
    pipeline: Pipeline = request.app.state.pipeline
    registry: dict = request.app.state.registry

    if avatar_id not in registry:
        # On-demand auto-load if reference frame exists on disk
        from avtr1_renderer.avtr1_artifact_manager import get_artifact_manager
        mgr = get_artifact_manager()
        portraits_dir = Path(getattr(pipeline, "_portraits_dir", None) or mgr.get_artifact_path("reference_frames"))
        portrait_path = portraits_dir / f"{avatar_id}.png"
        loader = getattr(pipeline, "_loader", None)
        if portrait_path.is_file() and loader is not None:
            try:
                registry[avatar_id] = loader.load(portrait_path, avatar_id=avatar_id)
                LOG.info("On-demand auto-loaded avatar '%s' into CUDA registry", avatar_id)
            except Exception as exc:
                LOG.warning("On-demand load failed for avatar '%s': %s", avatar_id, exc)

        if avatar_id not in registry:
            raise HTTPException(
                status_code=404,
                detail=f"Unknown avatar_id {avatar_id!r}; available: {sorted(registry)}",
            )

    avatar = registry[avatar_id]
    if bg_id.endswith(".png"):
        bg_id = bg_id[:-4]

    t_read = time.perf_counter()
    audio_bytes = (
        await current_chunk.read(),
        await future_chunk.read(),
        await current_chunk_listen.read(),
        await future_chunk_listen.read(),
    )

    state_blob_in = await state.read() if state is not None else None
    if state_blob_in is not None and len(state_blob_in) == 0:
        state_blob_in = None
    PROBE.record("render.req_read_ms", (time.perf_counter() - t_read) * 1000.0)

    options = RenderOptions(
        pixel_format=pixel_format,
        bg_id=bg_id,
        cfg_self_audio=cfg_self_audio,
        cfg_other_audio=cfg_other_audio,
        cfg_kp=cfg_kp,
        noise_alpha=noise_alpha,
        noise_trunc_z=noise_trunc_z,
    )

    loop = asyncio.get_running_loop()
    state_fut: asyncio.Future[bytes] = loop.create_future()
    send, recv = anyio.create_memory_object_stream[bytes](max_buffer_size=math.inf)

    run_in_thread(
        run_chunk,
        loop,
        state_fut,
        send,
        pipeline,
        avatar,
        audio_bytes,
        state_blob_in,
        options,
        request.app.state.current_samples,
        request.app.state.future_samples,
    )

    state_blob = await state_fut

    bg = pipeline._backgrounds[options.bg_id]
    out_h, out_w = int(bg.shape[-2]), int(bg.shape[-1])
    frame_bytes = get_bytes_per_frame(out_h, out_w, options.pixel_format)
    n_frames = pipeline._motion_generator.chunk_size

    async def body():
        try:
            yield state_blob
            async with recv:
                async for frame_chunk in recv:
                    yield frame_chunk
        except BaseException:
            logging.warning("Body streaming ended abruptly", exc_info=True)

    return StreamingResponse(
        body(),
        headers={
            "X-Num-Frames": str(n_frames),
            "X-Frame-Height": str(out_h),
            "X-Frame-Width": str(out_w),
            "X-Frame-Length-Bytes": str(frame_bytes),
            "X-Has-State": "yes",
            "X-State-Format": "safetensors",
            "X-State-Length-Bytes": str(len(state_blob)),
        },
    )


@app.get("/debug/latency")
async def debug_latency() -> dict:
    """Renderer-side step timings for the latency probe (merged by the streamer)."""
    return PROBE.snapshot()


@app.post("/debug/latency/reset")
async def debug_latency_reset() -> dict:
    PROBE.reset()
    return {"status": "ok"}


@app.get("/avatars")
@app.get("/api/avatar/avatars")
async def avatars(request: Request) -> dict[str, list[str]]:
    """List the avatar ids and background ids loaded at startup (sorted)."""
    registry: dict = getattr(request.app.state, "registry", None) or {}
    pipeline: Pipeline | None = getattr(request.app.state, "pipeline", None)

    # Check for any new avatar PNGs on disk
    if pipeline is not None:
        from avtr1_renderer.avtr1_artifact_manager import get_artifact_manager
        mgr = get_artifact_manager()
        portraits_dir = Path(getattr(pipeline, "_portraits_dir", None) or mgr.get_artifact_path("reference_frames"))
        loader = getattr(pipeline, "_loader", None)
        if loader and portraits_dir.exists():
            for p in portraits_dir.glob("*.png"):
                if p.stem not in registry:
                    try:
                        registry[p.stem] = loader.load(p, avatar_id=p.stem)
                        LOG.info("Auto-discovered and loaded avatar '%s' into registry", p.stem)
                    except Exception as e:
                        LOG.warning("Failed loading discovered avatar '%s': %s", p.stem, e)

    backgrounds: list[str] = []
    if pipeline is not None:
        backgrounds = sorted(b for b in pipeline._backgrounds if b != TRANSPARENT_BG_ID)
    return {"avatars": sorted(registry), "backgrounds": backgrounds}


@app.delete("/avatars/{avatar_id}")
@app.delete("/api/avatar/{avatar_id}")
async def delete_avatar_endpoint(avatar_id: str, request: Request):
    """Remove avatar from CUDA memory and delete reference image from disk."""
    target_id = avatar_id.strip().lower()
    registry = getattr(request.app.state, "registry", None)
    if isinstance(registry, dict) and target_id in registry:
        del registry[target_id]
        LOG.info("Removed avatar '%s' from CUDA registry", target_id)

    pipeline = getattr(request.app.state, "pipeline", None)
    if pipeline is not None:
        try:
            from avtr1_renderer.avtr1_artifact_manager import get_artifact_manager
            mgr = get_artifact_manager()
            portraits_dir = Path(getattr(pipeline, "_portraits_dir", None) or mgr.get_artifact_path("reference_frames"))
            target_file = portraits_dir / f"{target_id}.png"
            if target_file.is_file():
                target_file.unlink()
                LOG.info("Unlinked portrait reference file for '%s'", target_id)
        except Exception as e:
            LOG.warning("Failed unlinking reference frame for '%s': %s", target_id, e)

    return {"status": "ok", "deleted": target_id}


@app.post("/avatars/register")
@app.post("/api/avatar/register")
async def register_avatar_endpoint(request: Request):
    """Dynamically register a new avatar portrait into CUDA memory."""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    avatar_id = str(data.get("avatar_id") or "").strip().lower()
    if not avatar_id:
        raise HTTPException(status_code=400, detail="avatar_id is required")

    pipeline: Pipeline | None = getattr(request.app.state, "pipeline", None)
    registry: dict | None = getattr(request.app.state, "registry", None)
    if pipeline is None or registry is None:
        raise HTTPException(status_code=503, detail="Renderer pipeline not initialized")

    # Guard: Prevent replacing ANY currently added avatar in GPU registry
    if avatar_id in registry:
        raise HTTPException(
            status_code=409,
            detail=f"Avatar '{avatar_id}' already exists in active GPU registry. Please choose a unique name to avoid replacing an existing avatar.",
        )

    from avtr1_renderer.avtr1_artifact_manager import get_artifact_manager
    mgr = get_artifact_manager()
    portraits_dir = Path(getattr(pipeline, "_portraits_dir", None) or mgr.get_artifact_path("reference_frames"))
    portraits_dir.mkdir(parents=True, exist_ok=True)
    portrait_path = portraits_dir / f"{avatar_id}.png"

    img_b64 = data.get("image_base64") or data.get("image")
    if img_b64:
        import base64
        if "," in img_b64:
            img_b64 = img_b64.split(",", 1)[1]
        portrait_path.write_bytes(base64.b64decode(img_b64))
    elif data.get("image_path"):
        import shutil
        shutil.copy(data["image_path"], str(portrait_path))

    if not portrait_path.is_file():
        raise HTTPException(status_code=400, detail=f"No image available for avatar {avatar_id}")

    loader = getattr(pipeline, "_loader", None)
    if loader is None:
        raise HTTPException(status_code=500, detail="AvatarLoader not available on pipeline")

    try:
        avatar = loader.load(portrait_path, avatar_id=avatar_id)
        registry[avatar_id] = avatar
        LOG.info("Dynamically registered avatar '%s' into CUDA memory (total: %d)", avatar_id, len(registry))
    except Exception as exc:
        LOG.exception("Failed to dynamically register avatar %s", avatar_id)
        raise HTTPException(status_code=500, detail=f"Failed to register avatar: {exc}")

    # Optional: extract and cache voice cloning latents in VRAM if audio was passed
    audio_b64 = data.get("audio_base64") or data.get("audio")
    ref_voices_dirs = [
        Path("/root/avtr-1/reference_voices"),
        Path.cwd() / "reference_voices",
        Path.cwd() / "live_avatar" / "reference_voices",
    ]
    target_vdir = ref_voices_dirs[0]
    for d in ref_voices_dirs:
        if d.exists():
            target_vdir = d
            break
    target_vdir.mkdir(parents=True, exist_ok=True)

    if audio_b64 and isinstance(audio_b64, str):
        import base64
        if "," in audio_b64:
            audio_b64 = audio_b64.split(",", 1)[1]
        raw_audio = base64.b64decode(audio_b64)
        aud_path = target_vdir / f"{avatar_id}.ogg"
        aud_path.write_bytes(raw_audio)
        (target_vdir / f"{avatar_id}.wav").write_bytes(raw_audio)
        voice_cloned = await _XTTS.call(xtts_worker.extract_latents, avatar_id, str(aud_path))
    else:
        voice_cloned = await _XTTS.call(xtts_worker.has_speaker, avatar_id)

    backgrounds: list[str] = sorted(b for b in pipeline._backgrounds if b != TRANSPARENT_BG_ID)
    return {
        "status": "ok",
        "avatar_id": avatar_id,
        "avatars": sorted(registry),
        "backgrounds": backgrounds,
        "voice_cloned": voice_cloned,
    }


class VoiceSynthRequest(BaseModel):
    text: str
    avatar_id: str = "maria"
    language: str = "en"


@app.post("/api/voice/clone")
@app.post("/voice/clone")
async def voice_clone_endpoint(request: Request):
    """Zero-shot neural voice cloning endpoint: processes reference audio into VRAM latents."""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    avatar_id = str(data.get("avatar_id") or "").strip().lower()
    if not avatar_id:
        raise HTTPException(status_code=400, detail="avatar_id is required")

    ref_dirs = [
        Path("/root/avtr-1/reference_voices"),
        Path.cwd() / "reference_voices",
        Path.cwd() / "live_avatar" / "reference_voices",
    ]
    target_dir = ref_dirs[0]
    for d in ref_dirs:
        if d.exists():
            target_dir = d
            break
    target_dir.mkdir(parents=True, exist_ok=True)

    audio_b64 = data.get("audio_base64") or data.get("audio")
    audio_path = target_dir / f"{avatar_id}.ogg"
    if audio_b64 and isinstance(audio_b64, str):
        import base64
        if "," in audio_b64:
            audio_b64 = audio_b64.split(",", 1)[1]
        raw_bytes = base64.b64decode(audio_b64)
        audio_path.write_bytes(raw_bytes)
        (target_dir / f"{avatar_id}.wav").write_bytes(raw_bytes)

    found_audio = None
    for d in ref_dirs:
        for ext in [".ogg", ".wav", ".mp3"]:
            p = d / f"{avatar_id}{ext}"
            if p.is_file():
                found_audio = p
                break
        if found_audio:
            break

    if not found_audio:
        raise HTTPException(status_code=400, detail=f"No audio file found for voice cloning avatar {avatar_id}")

    cloned = await _XTTS.call(xtts_worker.extract_latents, avatar_id, str(found_audio))
    if not cloned:
        cloned = await _XTTS.call(xtts_worker.has_speaker, avatar_id)
    return {
        "status": "ok",
        "avatar_id": avatar_id,
        "cloned_in_vram": cloned,
    }


@app.post("/api/voice/synthesize")
@app.post("/voice/synthesize")
async def voice_synthesize_endpoint(request: Request, body: VoiceSynthRequest):
    """High-fidelity sub-second XTTS-v2 speech synthesis conditioned on in-VRAM speaker latents."""
    avatar_id = body.avatar_id.lower().strip()
    text = body.text.strip()
    lang = body.language.lower().strip() or "en"
    if not text:
        return Response(content=b"", media_type="application/octet-stream")

    try:
        pcm, inference_ms = await _XTTS.call(xtts_worker.synthesize, avatar_id, text, lang)
    except xtts_worker.SpeakerNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except xtts_worker.XttsUnavailableError as exc:
        raise HTTPException(status_code=503, detail=f"XTTS-v2 voice model not available: {exc}") from exc
    except Exception as exc:
        LOG.exception("Voice synthesis inference error for %s: %s", avatar_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    PROBE.record("xtts.inference_ms", inference_ms)
    return Response(content=pcm, media_type="application/octet-stream")


@app.get("/health")
async def health(request: Request):
    checker: CudaHealthChecker | None = getattr(request.app.state, "health", None)
    if checker is None:
        raise HTTPException(status_code=503, detail="starting")
    try:
        await checker.check()
    except Exception as exc:
        LOG.exception("cuda healthcheck failed")
        raise HTTPException(status_code=503, detail=f"cuda unhealthy: {exc}") from exc
    return {"status": "ok"}


class _DropSuccessfulAccess(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        status = record.args[4] if isinstance(record.args, tuple) and len(record.args) >= 5 else None
        if isinstance(status, int) and 200 <= status < 400:
            return False
        return True


# Applied at import time so it sticks whether this module is launched via
# `python -m avtr1_renderer.api.app` or via `python -m uvicorn avtr1_renderer.api.app:app`
# (the orchestrator uses the latter to pass --port). Uvicorn configures its own
# logging before importing the app, so our filter attaches after its handlers exist.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("uvicorn.access").addFilter(_DropSuccessfulAccess())


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    uvicorn.run("avtr1_renderer.api.app:app", host="0.0.0.0", port=8000)
