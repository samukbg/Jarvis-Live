# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Local-dev CLI: serves a tiny FastAPI app on localhost that lets a browser
peer connect via WebRTC, configure a conversation engine in the UI (OpenAI
Realtime / Cartesia, with credentials kept in the browser's localStorage), and
runs the same stream pipeline as `run-session` but with a `LocalRTC` peer
(aiortc-backed) in place of Daily.

No Daily API key or Daily SDK frontend required, and no OPENAI__API_KEY /
CARTESIA_* env vars: credentials are POSTed per-session and the server mints
short-lived tokens for each.

Sessions are one-at-a-time but reusable: disconnect and click Start again for
a new one.

Invoke via:
    uv run python -m avaturn_live_streamer.local_stream_cli [--host 0.0.0.0] [--port 7860]
"""

import asyncio
import time
import os
from enum import Enum
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx
from avaturn_live_streamer.wsl_distro import wsl_distro, wsl_unc_roots
import typer
import uvicorn
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from avaturn_live_streamer.core.logs import get_logger, setup_logging
from avaturn_live_streamer.settings import get_config
from avaturn_live_streamer.types import BackgroundId, RendererAvatarId
from avaturn_live_streamer.clocks import StreamClocks
from avaturn_live_streamer.config import RendererConfig
from avaturn_live_streamer.conversation_engines.builders import (
    BuiltEngine,
    EngineOptions,
    build_engine,
)
from avaturn_live_streamer.debug_routes import (
    log_latency_report,
    record_env_info,
    register_debug_routes,
)
from avaturn_live_streamer.event_bus import EventBus
from avaturn_live_streamer.vision import VISION
from avaturn_live_streamer.events import Shutdown
from avaturn_live_streamer.localrtc.watch_peer import WatchPeer
from avaturn_live_streamer.localrtc import (
    LocalRTC,
    LocalRTCWorklet,
    has_turn,
    resolve_ice_servers,
    serialize_ice_servers,
)


def _filter_sdp_to_relay_only(sdp: str) -> str:
    """Strip ``typ host`` and ``typ srflx`` candidate lines from an SDP answer.

    aiortc's ``RTCConfiguration`` in this version doesn't accept
    ``iceTransportPolicy``, so it always gathers all candidate types. When the
    server is on AWS behind an SG that blocks inbound UDP, the host/srflx
    candidates (private/docker IPs and the public IP) are useless to the
    browser; worse, Cloudflare TURN refuses ``CreatePermission`` for the RFC1918
    addresses and Firefox handles that by tearing down the whole TURN
    allocation -- killing the relay-relay pair too. By dropping the unusable
    candidates from the SDP we keep only the relay candidate, which the browser
    can reach via Cloudflare.
    """
    out: list[str] = []
    for line in sdp.splitlines():
        if line.startswith("a=candidate:") and (" typ host" in line or " typ srflx" in line):
            continue
        out.append(line)
    # Preserve trailing newline behavior of the original.
    return "\r\n".join(out) + ("\r\n" if sdp.endswith(("\n", "\r\n")) else "")
from avaturn_live_streamer.renderer import create_renderer_client_registry
from avaturn_live_streamer.runner import run_stream
from avaturn_live_streamer.types import PixelFormat
from avaturn_live_streamer.worklets.delayed_event import run_delayed_event_worklet
from avaturn_live_streamer.worklets.rendering import RenderingWorklet
from avaturn_live_streamer.worklets.timeout import TimeoutWorklet

_LOGGER = get_logger()

_UI_HTML_PATH = Path(__file__).parent / "local_stream_ui.html"


class _LogLevel(str, Enum):
    DEBUG = "DEBUG"
    INFO = "INFO"


class _OfferBody(BaseModel):
    engine: EngineOptions
    sdp: str
    type: Literal["offer"]
    avatar_id: str
    background_id: str


class _WatchStartBody(BaseModel):
    engine: EngineOptions
    avatar_id: str
    background_id: str = "bright_loft"
    # The watch screen in pixels: frames are cropped and scaled to it.
    width: int = 240
    height: int = 0
    fps: int = 12
    jpeg_quality: int = 70
    # False: don't take the avatar from a session already running (the watch app re-opening
    # on a wrist raise used to cut the iPhone's avatar off). Older watch builds omit it.
    preempt: bool = True


_RENDERER_MODEL = "avtrn-1"


def _renderer_base_url() -> str | None:
    if os.environ.get("RENDERER_URL"):
        return os.environ["RENDERER_URL"].rstrip("/")
    cfg = get_config()
    rc = cfg.renderers.renderers.get(_RENDERER_MODEL)
    if rc is not None and rc.lb_or_instance_url:
        return rc.lb_or_instance_url.rstrip("/")
    try:
        import subprocess
        res = subprocess.run(["wsl.exe", "-d", wsl_distro(), "-e", "hostname", "-I"], capture_output=True, text=True, timeout=2)
        ips = res.stdout.strip().split()
        if ips:
            return f"http://{ips[0]}:8000"
    except Exception:
        pass
    return "http://127.0.0.1:8000"


class _SessionSlot:
    """One concurrent session at a time. Slot is released when the session task ends."""

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._since: float | None = None

    @property
    def busy(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def since(self) -> float | None:
        """Unix time the current session started (None when free)."""
        return self._since if self.busy else None

    async def claim(self) -> None:
        async with self._lock:
            if self._task is not None and not self._task.done():
                _LOGGER.info("Preempting previous session for new incoming connection")
                self._task.cancel()
                try:
                    await asyncio.wait_for(asyncio.shield(self._task), timeout=1.5)
                except asyncio.CancelledError:
                    # The old session ending as cancelled is the point; only our own request
                    # being cancelled may propagate (it used to turn the new /offer into a 500).
                    current = asyncio.current_task()
                    if current is not None and current.cancelling():
                        raise
                except Exception:
                    pass
            self._task = None

    def attach(self, task: asyncio.Task[None]) -> None:
        self._task = task
        self._since = time.time()
        task.add_done_callback(self._on_done)

    def _on_done(self, task: asyncio.Task[None]) -> None:
        if task is self._task:
            self._task = None
        try:
            if task.cancelled():
                _LOGGER.info("local-stream session cancelled; slot free")
                return
            if (exc := task.exception()) is not None:
                _LOGGER.error("local-stream session failed; slot free", error=str(exc))
                return
            _LOGGER.info("local-stream session ended; slot free")
        except Exception:
            pass


async def _run_session(
    *,
    built_engine: BuiltEngine,
    peer: LocalRTC | WatchPeer,
    avatar: str,
    background: str,
    idle_timeout: int,
    max_duration: int,
) -> None:
    cfg = get_config()
    renderer_registry = create_renderer_client_registry(cfg.renderers)
    # Build the renderer config directly — the session/avatar DB is not vendored
    # for the localrtc-only slice; `avatar` here is the renderer-side avatar id.
    renderer_config = RendererConfig(
        avatar_id=RendererAvatarId(avatar),
        background_id=BackgroundId(background),
        pixel_format=PixelFormat.YUV_I420,
        model="avtrn-1",
    )
    _engine_config, engine_run = built_engine
    pixel_format = renderer_config.pixel_format

    rendering = RenderingWorklet(renderer_registry, renderer_config)
    peer_worklet = LocalRTCWorklet(peer, pixel_format)  # pyright: ignore [reportArgumentType] -- WatchPeer mirrors LocalRTC
    timeout_worklet = TimeoutWorklet(idle_timeout, max_duration)

    needs_stop = asyncio.Event()

    async def _emit_stop(bus: EventBus, _clock: StreamClocks):
        _ = _clock

        async def _set_stop():
            async with bus.subscribe(Shutdown) as sub:
                bus.ready()
                await sub.get_next()
                needs_stop.set()

        asyncio.create_task(_set_stop())
        await needs_stop.wait()
        await bus.publish(Shutdown())

    try:
        await run_stream(
            rendering.run,
            peer_worklet.run,
            run_delayed_event_worklet,
            engine_run,
            timeout_worklet.run,
            _emit_stop,
        )
    finally:
        await peer.close()
        log_latency_report()


def _make_app(
    *,
    idle_timeout: int,
    max_duration: int,
) -> FastAPI:
    app = FastAPI(title="Jarvis Live Avatar Streamer")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    slot = _SessionSlot()
    record_env_info(os.environ.get("RENDERER_URL"))
    register_debug_routes(app, _renderer_base_url)

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return _UI_HTML_PATH.read_text()

    @app.get("/avatars")
    @app.get("/api/avatar/avatars")
    @app.get("/api/avatar/avatars/")
    async def avatars_route() -> dict[str, object]:
        """Proxy of the renderer's ``/avatars`` endpoint.

        The renderer auto-discovers loaded avatars and backgrounds at startup;
        we surface both lists to the browser so the user can pick known-good
        ids. The browser UI is solely responsible for what's selected per
        session.
        """
        base = _renderer_base_url()
        result: dict[str, object] = {"avatars": [], "backgrounds": []}
        if not base:
            result["error"] = "renderer URL not configured"
            return result
        try:
            async with httpx.AsyncClient(timeout=5.0) as http:
                r = await http.get(f"{base}/avatars")
                r.raise_for_status()
                data = r.json()
        except Exception as exc:
            _LOGGER.warning("renderer /avatars proxy failed, falling back to disk reference frames", error=str(exc))
            root_dir = Path(__file__).resolve().parent.parent.parent.parent
            ref_dir = root_dir / "artifacts" / "main" / "avatars_artifacts" / "reference_frames"
            if ref_dir.is_dir():
                result["avatars"] = sorted(p.stem for p in ref_dir.glob("*.png"))
            return result
        if isinstance(data, dict):
            avatars_list = data.get("avatars")
            if isinstance(avatars_list, list):
                result["avatars"] = [str(a) for a in avatars_list]
            backgrounds_list = data.get("backgrounds")
            if isinstance(backgrounds_list, list):
                result["backgrounds"] = [str(b) for b in backgrounds_list]
        return result

    @app.get("/ice-servers")
    @app.get("/api/avatar/ice-servers")
    @app.get("/api/avatar/ice-servers/")
    async def ice_servers_route() -> dict[str, object]:
        servers = await resolve_ice_servers()
        return {
            "iceServers": serialize_ice_servers(servers),
            "iceTransportPolicy": "all",
        }

    @app.post("/api/avatar/upload")
    @app.post("/upload-avatar")
    @app.post("/avatars/upload")
    async def upload_avatar_route(body: dict[str, object]) -> dict[str, object]:
        """Dynamically add an avatar to live streamer & renderer without restart."""
        import base64
        import re

        raw_id = str(body.get("avatar_id") or body.get("name") or "").strip().lower()
        avatar_id = re.sub(r"[^a-z0-9_]", "_", raw_id).strip("_")
        if not avatar_id:
            raise HTTPException(status_code=400, detail="Avatar name or id is required")

        image_data = body.get("image") or body.get("image_base64")
        audio_data = body.get("audio") or body.get("audio_base64")
        voice = str(body.get("voice") or "Kore")
        gender = str(body.get("gender") or "female")

        root_dir = Path(__file__).resolve().parent.parent.parent.parent
        # 1. Save portrait reference frame
        ref_frames_dir = root_dir / "artifacts" / "main" / "avatars_artifacts" / "reference_frames"
        ref_frames_dir.mkdir(parents=True, exist_ok=True)
        if image_data and isinstance(image_data, str):
            b64_str = image_data.split(",", 1)[1] if "," in image_data else image_data
            raw_bytes = base64.b64decode(b64_str)
            try:
                import io
                from PIL import Image, ImageFilter, ImageEnhance
                im = Image.open(io.BytesIO(raw_bytes))
                target_w, target_h = 1920, 1080
                w, h = im.size
                if abs((w / h) - (target_w / target_h)) < 0.03:
                    formatted = raw_bytes
                else:
                    scale = min(target_h / h, target_w / w)
                    new_w = max(1, int(round(w * scale)))
                    new_h = max(1, int(round(h * scale)))
                    im_scaled = im.resize((new_w, new_h), Image.Resampling.LANCZOS)
                    if im.mode == "RGBA":
                        canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
                        px = (target_w - new_w) // 2
                        py = target_h - new_h
                        canvas.paste(im_scaled, (px, py), im_scaled)
                    else:
                        bg_scale = max(target_w / w, target_h / h)
                        bg_w = max(target_w, int(round(w * bg_scale)))
                        bg_h = max(target_h, int(round(h * bg_scale)))
                        bg = im.resize((bg_w, bg_h), Image.Resampling.LANCZOS)
                        left = (bg_w - target_w) // 2
                        top = (bg_h - target_h) // 2
                        bg = bg.crop((left, top, left + target_w, top + target_h))
                        bg = bg.filter(ImageFilter.GaussianBlur(radius=35))
                        bg = ImageEnhance.Brightness(bg).enhance(0.75)
                        px = (target_w - new_w) // 2
                        py = target_h - new_h
                        bg.paste(im_scaled, (px, py))
                        canvas = bg
                    buf = io.BytesIO()
                    canvas.save(buf, format="PNG")
                    formatted = buf.getvalue()
                img_path.write_bytes(formatted)
                # Also mirror to public/avatars for frontend preview
                pub_dir = root_dir / "public" / "avatars"
                if pub_dir.exists():
                    (pub_dir / f"{avatar_id}.png").write_bytes(formatted)
            except Exception as e:
                _LOGGER.warning("Image 16:9 formatting fallback to raw bytes", error=str(e))
                img_path.write_bytes(raw_bytes)

        # 2. Save reference voice audio (.ogg / .wav)
        ref_voices_dir = root_dir / "reference_voices"
        ref_voices_dir.mkdir(parents=True, exist_ok=True)
        if audio_data and isinstance(audio_data, str):
            b64_audio = audio_data.split(",", 1)[1] if "," in audio_data else audio_data
            audio_bytes = base64.b64decode(b64_audio)
            (ref_voices_dir / f"{avatar_id}.ogg").write_bytes(audio_bytes)
            (ref_voices_dir / f"{avatar_id}.wav").write_bytes(audio_bytes)

        # Direct sync to WSL2 filesystem if accessible via UNC path
        for wsl_prefix in wsl_unc_roots():
            try:
                if Path(wsl_prefix).exists():
                    wsl_rf = Path(wsl_prefix) / "root" / "avtr-1" / "artifacts" / "main" / "avatars_artifacts" / "reference_frames"
                    wsl_rf.mkdir(parents=True, exist_ok=True)
                    if img_path.is_file():
                        import shutil
                        shutil.copyfile(str(img_path), str(wsl_rf / f"{avatar_id}.png"))
                    wsl_rv = Path(wsl_prefix) / "root" / "avtr-1" / "reference_voices"
                    wsl_rv.mkdir(parents=True, exist_ok=True)
                    if (ref_voices_dir / f"{avatar_id}.ogg").is_file():
                        import shutil
                        shutil.copyfile(str(ref_voices_dir / f"{avatar_id}.ogg"), str(wsl_rv / f"{avatar_id}.ogg"))
                        shutil.copyfile(str(ref_voices_dir / f"{avatar_id}.wav"), str(wsl_rv / f"{avatar_id}.wav"))
                    break
            except Exception as e:
                _LOGGER.debug("WSL direct UNC copy note", error=str(e))

        # 3. Dynamically notify CUDA renderer for avatar portrait & neural voice cloning
        renderer_registered = False
        voice_cloned = False
        base = _renderer_base_url()
        if base:
            try:
                async with httpx.AsyncClient(timeout=60.0) as http:
                    payload = {"avatar_id": avatar_id}
                    if image_data:
                        payload["image_base64"] = image_data
                    elif img_path.is_file():
                        payload["image_base64"] = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    if audio_data:
                        payload["audio_base64"] = audio_data

                    reg_resp = await http.post(
                        f"{base}/avatars/register",
                        json=payload,
                    )
                    if reg_resp.is_success:
                        renderer_registered = True
                        _LOGGER.info("Successfully registered avatar with renderer", avatar_id=avatar_id)
                    else:
                        _LOGGER.warning("Renderer register returned error", status=reg_resp.status_code, body=reg_resp.text)

                    if audio_data:
                        clone_resp = await http.post(
                            f"{base}/api/voice/clone",
                            json={"avatar_id": avatar_id, "audio_base64": audio_data},
                        )
                        if clone_resp.is_success:
                            voice_cloned = True
                            _LOGGER.info("Successfully extracted & pinned XTTS-v2 voice latents in VRAM", avatar_id=avatar_id)
                        else:
                            _LOGGER.warning("Voice clone returned error", status=clone_resp.status_code, body=clone_resp.text)
            except Exception as e:
                _LOGGER.warning("Renderer dynamic registration/voice clone skipped or failed", error=str(e))

        return {
            "success": True,
            "avatar_id": avatar_id,
            "voice": voice,
            "gender": gender,
            "renderer_registered": renderer_registered,
            "voice_cloned": voice_cloned,
        }

    @app.delete("/api/avatar/{avatar_id}")
    @app.delete("/api/avatar/{avatar_id}/")
    async def delete_avatar_route(avatar_id: str):
        target_id = avatar_id.strip().lower()
        root_dir = Path(__file__).resolve().parent.parent.parent.parent
        ref_frame = root_dir / "artifacts" / "main" / "avatars_artifacts" / "reference_frames" / f"{target_id}.png"
        if ref_frame.is_file():
            try:
                ref_frame.unlink()
            except Exception:
                pass
        for ext in [".ogg", ".wav"]:
            vf = root_dir / "reference_voices" / f"{target_id}{ext}"
            if vf.is_file():
                try:
                    vf.unlink()
                except Exception:
                    pass
        pub_file = root_dir / "public" / "avatars" / f"{target_id}.png"
        if pub_file.is_file():
            try:
                pub_file.unlink()
            except Exception:
                pass
        base = _renderer_base_url()
        if base:
            try:
                async with httpx.AsyncClient(timeout=4.0) as http:
                    await http.delete(f"{base}/avatars/{target_id}")
            except Exception:
                pass
        return {"status": "ok", "deleted": target_id}

    @app.post("/vision-frame")
    @app.post("/api/avatar/vision-frame")
    async def vision_frame(body: dict[str, str]) -> dict[str, str]:
        """Camera / screen frame from the phone, forwarded to the live Gemini session."""
        try:
            VISION.publish(body.get("mimeType", "image/jpeg"), body.get("data", ""))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"status": "ok"}

    @app.post("/probe-offer")
    @app.post("/api/avatar/probe-offer")
    @app.post("/api/avatar/probe-offer/")
    async def probe_offer(body: dict[str, str]) -> dict[str, str]:
        """ICE-only probe: negotiate a PC with policy=all and close it shortly."""
        sdp = body.get("sdp")
        type_ = body.get("type")
        if not sdp or type_ != "offer":
            raise HTTPException(status_code=400, detail="missing sdp/type=offer")
        servers = await resolve_ice_servers()
        pc = RTCPeerConnection(
            configuration=RTCConfiguration(iceServers=servers),
        )
        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=type_))
        answer = await pc.createAnswer()
        assert answer is not None
        await pc.setLocalDescription(answer)

        async def _close_later() -> None:
            await asyncio.sleep(15.0)
            try:
                await pc.close()
            except Exception:
                pass

        asyncio.create_task(_close_later())
        local = pc.localDescription
        sdp_out = local.sdp
        if has_turn(servers) and os.environ.get("FORCE_RELAY", "").lower() in ("1", "true"):
            sdp_out = _filter_sdp_to_relay_only(sdp_out)
        return {"sdp": sdp_out, "type": local.type}

    # ── Apple Watch: the avatar over plain HTTP (see localrtc/watch_peer.py) ──
    watch_peers: dict[str, WatchPeer] = {}

    # Is the single avatar session slot in use? The backend reports it in
    # /api/server/status so clients can tell a busy server apart (a new session
    # would preempt the current one).
    @app.get("/session-status")
    @app.get("/api/avatar/session-status")
    async def session_status() -> dict[str, Any]:
        return {"busy": slot.busy, "since": slot.since}

    @app.post("/api/avatar/watch/start")
    async def watch_start(body: _WatchStartBody) -> dict[str, str]:
        chosen_avatar = body.avatar_id.strip()
        if not chosen_avatar:
            raise HTTPException(status_code=400, detail="avatar_id is required")
        if not body.preempt and slot.busy:
            raise HTTPException(status_code=409, detail="The avatar is in use on another device.")
        await slot.claim()
        try:
            if hasattr(body.engine, "avatar_id"):
                body.engine.avatar_id = chosen_avatar
            built_engine = await build_engine(body.engine, stream_id="watch")
        except Exception as exc:
            _LOGGER.warning("watch engine build failed", error=str(exc))
            raise HTTPException(status_code=400, detail=f"engine build failed: {exc}") from exc
        for old in list(watch_peers.values()):
            await old.close()
        watch_peers.clear()
        session = uuid.uuid4().hex
        peer = WatchPeer(
            fps=max(1, min(body.fps, 25)),
            width=max(64, min(body.width, 512)),
            height=max(0, min(body.height, 640)),
            jpeg_quality=max(30, min(body.jpeg_quality, 90)),
        )
        watch_peers[session] = peer

        async def _run() -> None:
            try:
                await _run_session(
                    built_engine=built_engine,
                    peer=peer,
                    avatar=chosen_avatar,
                    background=body.background_id.strip() or "bright_loft",
                    idle_timeout=idle_timeout,
                    max_duration=max_duration,
                )
            finally:
                watch_peers.pop(session, None)

        slot.attach(asyncio.create_task(_run()))
        return {"session": session}

    @app.get("/api/avatar/watch/stream")
    async def watch_stream(session: str) -> StreamingResponse:
        peer = watch_peers.get(session)
        if peer is None:
            raise HTTPException(status_code=404, detail="unknown watch session")
        return StreamingResponse(
            peer.lines(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/avatar/watch/audio")
    async def watch_audio(session: str, request: Request) -> dict[str, bool]:
        peer = watch_peers.get(session)
        if peer is None:
            raise HTTPException(status_code=404, detail="unknown watch session")
        seq = request.headers.get("x-seq")
        accepted = peer.feed_mic(await request.body(), int(seq) if seq and seq.isdigit() else None)
        return {"ok": accepted}

    @app.post("/api/avatar/watch/stop")
    async def watch_stop(session: str) -> dict[str, bool]:
        peer = watch_peers.pop(session, None)
        if peer is not None:
            await peer.close()
        return {"ok": True}

    @app.post("/offer")
    @app.post("/api/avatar/offer")
    @app.post("/api/avatar/offer/")
    async def offer(body: _OfferBody) -> dict[str, str]:
        await slot.claim()

        # Build the conversation engine up front (mints any tokens) so credential
        # / network errors surface as HTTP 4xx/5xx here instead of disappearing
        # into the fire-and-forget session task.
        try:
            if hasattr(body.engine, "avatar_id") and body.avatar_id:
                body.engine.avatar_id = body.avatar_id.strip()
            built_engine = await build_engine(body.engine, stream_id="local")
        except HTTPException:
            raise
        except Exception as exc:
            _LOGGER.warning("engine build failed", error=str(exc))
            raise HTTPException(status_code=400, detail=f"engine build failed: {exc}") from exc

        ice_servers = await resolve_ice_servers()
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice_servers))
        peer = LocalRTC(pc)

        # Diagnostic: log the candidate types the browser actually sent us. If
        # the offer doesn't include relay candidates, the wait-for-gathering
        # change on the JS side didn't take effect.
        remote_candidate_lines = [
            line for line in body.sdp.splitlines() if line.startswith("a=candidate:")
        ]
        _LOGGER.info(
            "/offer remote candidates",
            count=len(remote_candidate_lines),
            candidates=remote_candidate_lines,
        )

        await pc.setRemoteDescription(RTCSessionDescription(sdp=body.sdp, type=body.type))
        answer = await pc.createAnswer()
        assert answer is not None
        await pc.setLocalDescription(answer)

        # Diagnostic: log the candidates the server gathered. If our SDP filter
        # is overly aggressive (or aiortc didn't gather any relay), we'll see it.
        local_candidate_lines = [
            line for line in pc.localDescription.sdp.splitlines() if line.startswith("a=candidate:")
        ]
        _LOGGER.info(
            "/offer local candidates",
            count=len(local_candidate_lines),
            candidates=local_candidate_lines,
        )

        chosen_avatar = body.avatar_id.strip()
        if not chosen_avatar:
            raise HTTPException(status_code=400, detail="avatar_id is required")
        chosen_background = body.background_id.strip()
        if not chosen_background:
            raise HTTPException(status_code=400, detail="background_id is required")
        task = asyncio.create_task(
            _run_session(
                built_engine=built_engine,
                peer=peer,
                avatar=chosen_avatar,
                background=chosen_background,
                idle_timeout=idle_timeout,
                max_duration=max_duration,
            )
        )
        slot.attach(task)

        local = pc.localDescription
        sdp_out = local.sdp
        if has_turn(ice_servers) and os.environ.get("FORCE_RELAY", "").lower() in ("1", "true"):
            sdp_out = _filter_sdp_to_relay_only(sdp_out)
        return {"sdp": sdp_out, "type": local.type}

    return app


def run_local_stream(
    host: Annotated[
        str, typer.Option(help="Bind address (use 0.0.0.0 for remote/Docker)")
    ] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Local server port")] = 8081,
    idle_timeout: Annotated[int, typer.Option(help="Idle timeout (s)")] = 30,
    max_duration: Annotated[int, typer.Option(help="Max session duration (s)")] = 3600,
    log_level: Annotated[_LogLevel, typer.Option()] = _LogLevel.INFO,
) -> None:
    """Start a local WebRTC streaming session server (aiortc-backed).

    Opens a localhost UI; pick an engine in the browser and click Start.
    Requires aiortc/av (dev dependencies). Does not use Daily.
    """
    cfg = get_config()
    cfg.logging.level = log_level.value
    setup_logging(cfg.logging)

    # httpx logs every renderer request at INFO; demote to WARNING.
    import logging as _logging

    _logging.getLogger("httpx").setLevel(_logging.WARNING)
    _logging.getLogger("httpcore").setLevel(_logging.WARNING)

    if not _UI_HTML_PATH.exists():
        raise RuntimeError(f"UI HTML missing at {_UI_HTML_PATH}")

    app = _make_app(
        idle_timeout=idle_timeout,
        max_duration=max_duration,
    )
    _LOGGER.info("local-stream server starting", host=host, port=port)
    display_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    print(f"Open http://{display_host}:{port}/ in your browser (or the host's reachable address).")

    uvicorn.run(app, host=host, port=port, log_level=log_level.value.lower())


if __name__ == "__main__":
    typer.run(run_local_stream)
