# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Latency debug endpoints for the local streamer.

``GET  /debug/latency``        streamer probe + renderer probe + latest client stats
``POST /debug/latency/reset``  clear streamer, renderer and client numbers
``POST /client-stats``         5 s WebRTC ``getStats`` summaries from the mobile avatar WebView
``GET  /debug/input``          what was sent to Gemini in the last minute, and what it heard
``GET  /debug/input.wav``      that audio (16 kHz mono)

Each is also mounted under ``/api/avatar/...`` to match the backend proxy paths.
"""

import os
import platform
from collections.abc import Callable
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.responses import Response

from avaturn_live_streamer import constant
from avaturn_live_streamer.core.logs import get_logger
from avaturn_live_streamer.utils.input_tap import INPUT_TAP
from avaturn_live_streamer.utils.latency_probe import PROBE

_LOGGER = get_logger()

# Numeric client fields recorded as rolling metrics (value per 5 s window).
_CLIENT_METRICS = {
    "fps": "client.fps",
    "jitterBufferMs": "client.jitter_buffer_ms",
    "decodeMs": "client.decode_ms",
    "rttMs": "client.rtt_ms",
    "kbps": "client.video_kbps",
}
# Per-window deltas accumulated as counters.
_CLIENT_COUNTERS = {
    "framesDropped": "client.frames_dropped",
    "framesReceived": "client.frames_received",
    "freezeCount": "client.freezes",
    "freezeMs": "client.freeze_ms_total",
}


def record_env_info(renderer_url: str | None) -> None:
    PROBE.set_info("host.platform", platform.platform())
    PROBE.set_info("host.cpu_count", os.cpu_count())
    PROBE.set_info("renderer.url", renderer_url)
    PROBE.set_info("video.resolution", f"{constant.VIDEO_RESOLUTION[1]}x{constant.VIDEO_RESOLUTION[0]}")
    try:
        import aiortc
        import av

        PROBE.set_info("lib.aiortc", aiortc.__version__)
        PROBE.set_info("lib.av", av.__version__)
        PROBE.set_info("rtc.h264_nvenc_available", "h264_nvenc" in av.codecs_available)
    except Exception as exc:
        PROBE.set_info("lib.error", str(exc))


def _ingest_client_stats(body: dict[str, Any]) -> None:
    for key, metric in _CLIENT_METRICS.items():
        value = body.get(key)
        if isinstance(value, int | float):
            PROBE.record(metric, float(value))
    for key, counter in _CLIENT_COUNTERS.items():
        value = body.get(key)
        if isinstance(value, int | float) and value > 0:
            PROBE.incr(counter, int(value))
    for key in ("candidatePair", "codec", "resolution", "network"):
        if body.get(key):
            PROBE.set_info(f"client.{key}", body[key])


def register_debug_routes(app: FastAPI, renderer_url: Callable[[], str | None]) -> None:
    client_last: dict[str, Any] = {}

    async def _renderer_call(method: str, path: str) -> Any:
        base = renderer_url()
        if not base:
            return {"error": "renderer url unknown"}
        try:
            async with httpx.AsyncClient(timeout=3.0) as http:
                rsp = await http.request(method, f"{base}{path}")
                rsp.raise_for_status()
                return rsp.json()
        except Exception as exc:
            return {"error": f"{type(exc).__name__}: {exc}"}

    @app.get("/debug/latency")
    @app.get("/api/avatar/debug/latency")
    async def debug_latency() -> dict[str, Any]:
        return {
            "streamer": PROBE.snapshot(),
            "renderer": await _renderer_call("GET", "/debug/latency"),
            "client_last": client_last,
        }

    @app.post("/debug/latency/reset")
    @app.post("/api/avatar/debug/latency/reset")
    async def debug_latency_reset() -> dict[str, Any]:
        PROBE.reset()
        client_last.clear()
        return {"status": "ok", "renderer": await _renderer_call("POST", "/debug/latency/reset")}

    @app.get("/debug/input")
    @app.get("/api/avatar/debug/input")
    async def debug_input() -> dict[str, Any]:
        return INPUT_TAP.info()

    @app.get("/debug/input.wav")
    @app.get("/api/avatar/debug/input.wav")
    async def debug_input_wav() -> Response:
        return Response(INPUT_TAP.wav(), media_type="audio/wav")

    @app.post("/client-stats")
    @app.post("/api/avatar/client-stats")
    async def client_stats(body: dict[str, Any]) -> dict[str, str]:
        _ingest_client_stats(body)
        client_last.clear()
        client_last.update(body)
        return {"status": "ok"}


def log_latency_report() -> None:
    _LOGGER.info("\n" + PROBE.format_report("AVATAR LATENCY REPORT"))
