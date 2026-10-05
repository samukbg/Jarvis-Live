"""Jarvis voice server: XTTS-v2 voice cloning on a machine's own GPU.

One RTX 3090 can't render the 25 fps live avatar and run XTTS in real time — each
slowed the other — so the cloned voice can run here, on a second machine, while the
first machine's GPU only renders the face. The streamer reaches it through that
machine's backend (POST /api/voice/synthesize, x-api-key) when XTTS_URL is set.

    voice_env\\Scripts\\python.exe live_avatar\\voice_server\\server.py   (port 8010)

Only needs torch (CUDA), coqui-tts, fastapi, uvicorn and numpy — not the renderer.
"""

import asyncio
import importlib.util
import os
import sys
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
LIVE_AVATAR = HERE.parent
os.chdir(LIVE_AVATAR.parent)  # repo root: live_avatar/reference_voices is found from here
os.environ.setdefault("COQUI_TOS_AGREED", "1")
os.environ.setdefault("XTTS_DEVICE", "cuda")

# Load the worker by path: importing the avtr1_renderer package pulls in the renderer.
_spec = importlib.util.spec_from_file_location("xtts_worker", LIVE_AVATAR / "src/avtr1_renderer/api/xtts_worker.py")
xtts = importlib.util.module_from_spec(_spec)
sys.modules["xtts_worker"] = xtts
_spec.loader.exec_module(xtts)

app = FastAPI(title="Jarvis voice server")
_lock = asyncio.Lock()  # XTTS is not thread-safe: one synthesis at a time


class SynthBody(BaseModel):
    text: str
    avatar_id: str = "maria"
    language: str = "en"


@app.on_event("startup")
async def _load() -> None:
    await asyncio.to_thread(xtts.init_worker)
    await asyncio.to_thread(_warm_up)


def _warm_up() -> None:
    """The first streamed synthesis compiles CUDA kernels (~5 s): do it before anyone talks."""
    voice = next(iter(sorted(xtts._latents)), None)
    if voice is None:
        return
    t0 = time.perf_counter()
    try:
        for _ in xtts.synthesize_stream(voice, "Hello, I am ready.", "en"):
            pass
        print(f"[voice] warmed up with {voice} in {(time.perf_counter() - t0) * 1000:.0f} ms", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[voice] warm-up failed: {exc}", flush=True)


@app.post("/api/voice/synthesize")
@app.post("/voice/synthesize")
async def synthesize(body: SynthBody) -> Response:
    text = body.text.strip()
    if not text:
        return Response(content=b"", media_type="application/octet-stream")
    async with _lock:
        try:
            pcm, ms = await asyncio.to_thread(xtts.synthesize, body.avatar_id.strip().lower(), text, body.language.strip().lower() or "en")
        except xtts.SpeakerNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except xtts.XttsUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(content=pcm, media_type="application/octet-stream", headers={"X-Inference-Ms": f"{ms:.0f}"})


@app.post("/api/voice/stream")
@app.post("/voice/stream")
async def synthesize_stream(body: SynthBody) -> StreamingResponse:
    """Like /api/voice/synthesize, but the PCM is sent while XTTS generates it."""
    text = body.text.strip()
    avatar = body.avatar_id.strip().lower()
    lang = body.language.strip().lower() or "en"
    # Unknown voice / model down → a status code before streaming starts.
    try:
        await asyncio.to_thread(xtts._speaker, avatar)
    except xtts.SpeakerNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    async def pcm():
        if not text:
            return
        async with _lock:
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()
            stop = threading.Event()  # the client went away: stop generating

            def run() -> None:
                t0 = time.perf_counter()
                first = None
                try:
                    for piece in xtts.synthesize_stream(avatar, text, lang, stop.is_set):
                        if first is None:
                            first = (time.perf_counter() - t0) * 1000
                        loop.call_soon_threadsafe(queue.put_nowait, piece)
                except Exception as exc:  # noqa: BLE001 — reported in the log, the stream just ends
                    print(f"[voice] stream failed: {exc}", flush=True)
                finally:
                    total = (time.perf_counter() - t0) * 1000
                    print(f"[voice] {avatar}/{lang} first {first or 0:.0f} ms, total {total:.0f} ms: {text[:50]!r}", flush=True)
                    loop.call_soon_threadsafe(queue.put_nowait, None)

            worker = asyncio.create_task(asyncio.to_thread(run))
            try:
                while (piece := await queue.get()) is not None:
                    yield piece
            finally:
                stop.set()
                await worker

    return StreamingResponse(pcm(), media_type="application/octet-stream")


@app.get("/health")
async def health() -> dict:
    return {"ok": xtts._model is not None, "device": xtts._device(), "voices": sorted(xtts._latents)}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("VOICE_SERVER_PORT", "8010")))
