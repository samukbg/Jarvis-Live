# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Apple Watch transport: the `LocalRTC` interface over plain HTTP.

watchOS has no WebRTC and blocks WebSockets for normal apps, so the watch gets
the avatar as a newline-delimited JSON stream (JPEG frames + 24 kHz PCM) and
posts its microphone PCM back. `LocalRTCWorklet` drives this peer exactly like a
WebRTC one: push_video_frame / push_audio_chunk / recv_audio_chunk.

Two things make it behave like a browser for the rest of the pipeline:
- frames are cropped to the watch's aspect and scaled to its screen pixels (a
  240 px landscape frame cropped to a portrait face looked like mosaic);
- the microphone is re-timed into a continuous 20 ms stream, silence included,
  like WebRTC — the watch posts bursts only while listening, which made the
  user-speech stream start and stop on every POST.
"""

import asyncio
import base64
import contextlib
import json
import math
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

import av
import numpy as np

from avaturn_live_streamer import constant
from avaturn_live_streamer.core.logs import get_logger
from avaturn_live_streamer.localrtc.peer import ConnectionState
from avaturn_live_streamer.speech.speech_buffer import SpeechBuffer
from avaturn_live_streamer.utils.latency_probe import PROBE

_LOGGER = get_logger()

_OUT_QUEUE_MAX = 400
_MIC_RATE = constant.NATIVE_SPEECH_SAMPLE_RATE
_MIC_CHUNK_BYTES = _MIC_RATE // 50 * 2  # 20 ms of s16 mono, the WebRTC packet size
_MIC_CHUNK_S = 0.02
_MIC_PREBUFFER_BYTES = _MIC_CHUNK_BYTES * 6  # 120 ms absorbs HTTP POST jitter
_MIC_MAX_BYTES = _MIC_RATE * 2 * 2  # keep at most 2 s
_SILENCE = bytes(_MIC_CHUNK_BYTES)


def _jpeg_qscale(quality: int) -> int:
    """JPEG quality (1-100, higher is better) → MJPEG qscale (2-31, lower is better)."""
    return max(2, min(31, round(2 + (100 - quality) * 29 / 99)))


def _even(n: float) -> int:
    return max(2, int(n) // 2 * 2)


class WatchPeer:
    def __init__(self, *, fps: int = 12, width: int = 240, height: int = 0, jpeg_quality: int = 70) -> None:
        """`width` x `height`: the watch screen in pixels (height 0 keeps the video's aspect)."""
        self._out: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._inbound: asyncio.Queue[SpeechBuffer] = asyncio.Queue(maxsize=600)
        self._state: ConnectionState = "new"
        self._waiters: list[asyncio.Future[ConnectionState]] = []
        # Frames arrive at VIDEO_FPS: send every Nth one.
        self._stride = max(1, round(constant.VIDEO_FPS / max(1, fps)))
        self._frame_no = 0
        self._width = width
        self._height = height
        self._quality = jpeg_quality
        self._encoding = False
        self._encoder: av.CodecContext | None = None
        # One worker: PyAV crashes when frames are reformatted/encoded concurrently.
        self._encode_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="watch-jpeg")
        self._encode_task: asyncio.Task[None] | None = None
        self._jpeg_pts = 0
        self._mic = bytearray()
        self._mic_seq = 0  # last X-Seq accepted (0: none yet)
        self._mic_primed = False
        self._mic_task: asyncio.Task[None] | None = None

    # ── connection state (same contract as LocalRTC) ──────────────────────────
    def _set_state(self, state: ConnectionState) -> None:
        _LOGGER.info("watch peer state", state=state)
        self._state = state
        waiters, self._waiters = self._waiters, []
        for w in waiters:
            if not w.done():
                w.set_result(state)

    @property
    def connection_state(self) -> ConnectionState:
        return self._state

    async def wait_state_change(self) -> ConnectionState:
        fut: asyncio.Future[ConnectionState] = asyncio.get_event_loop().create_future()
        self._waiters.append(fut)
        return await fut

    async def wait_connected(self, timeout: float = 30.0) -> None:
        async with asyncio.timeout(timeout):
            while self._state != "connected":
                if self._state in ("closed", "failed"):
                    raise ConnectionError(f"watch peer entered {self._state!r} before connecting")
                await self.wait_state_change()

    # ── outbound: avatar video + voice → NDJSON lines ─────────────────────────
    def _emit(self, obj: dict[str, str]) -> None:
        if self._state in ("closed", "failed"):
            return
        if self._out.qsize() >= _OUT_QUEUE_MAX:
            # The watch fell behind: drop the oldest line (video is re-sent several times a second).
            with contextlib.suppress(asyncio.QueueEmpty):
                self._out.get_nowait()
        self._out.put_nowait((json.dumps(obj, separators=(",", ":")) + "\n").encode())

    def _target_size(self, frame: av.VideoFrame) -> tuple[int, int]:
        width = _even(self._width)
        height = _even(self._height) if self._height > 0 else _even(frame.height * width / frame.width)
        return width, height

    def _mjpeg(self, width: int, height: int) -> av.CodecContext:
        # One encoder per session, single-threaded: a new context per frame spun up
        # FFmpeg's thread pool (32 threads on the GPU box) for every 2 KB JPEG.
        enc = self._encoder
        if enc is None or (enc.width, enc.height) != (width, height):
            enc = av.CodecContext.create("mjpeg", "w")
            enc.width, enc.height, enc.pix_fmt = width, height, "yuvj420p"
            enc.time_base = Fraction(1, constant.VIDEO_FPS)
            enc.thread_count = 1
            with contextlib.suppress(AttributeError):  # qmin/qmax: PyAV >= 13
                enc.qmin = enc.qmax = _jpeg_qscale(self._quality)
            self._encoder = enc
        return enc

    def _encode(self, frame: av.VideoFrame) -> bytes:
        """Scale the frame to cover the watch screen, centre-crop, JPEG."""
        width, height = self._target_size(frame)
        scale = max(width / frame.width, height / frame.height)
        sw, sh = _even(math.ceil(frame.width * scale)), _even(math.ceil(frame.height * scale))
        sw, sh = max(sw, width), max(sh, height)
        try:
            scaled = frame.reformat(width=sw, height=sh, format="rgb24", interpolation="AREA")
        except (TypeError, ValueError):
            scaled = frame.reformat(width=sw, height=sh, format="rgb24")
        if (sw, sh) != (width, height):
            x0, y0 = (sw - width) // 2, (sh - height) // 2
            rgb = np.ascontiguousarray(scaled.to_ndarray()[y0 : y0 + height, x0 : x0 + width])
            scaled = av.VideoFrame.from_ndarray(rgb, format="rgb24")
        out = scaled.reformat(format="yuvj420p")
        out.pts = self._jpeg_pts
        self._jpeg_pts += 1
        return b"".join(bytes(p) for p in self._mjpeg(width, height).encode(out))

    async def _encode_and_emit(self, frame: av.VideoFrame) -> None:
        try:
            with PROBE.timed("watch.encode_ms"):
                jpeg = await asyncio.get_running_loop().run_in_executor(self._encode_pool, self._encode, frame)
            if jpeg:
                self._emit({"t": "v", "d": base64.b64encode(jpeg).decode("ascii")})
        except Exception:
            _LOGGER.exception("watch frame encode failed")
        finally:
            self._encoding = False

    async def push_video_frame(self, frame: av.VideoFrame) -> None:
        # Never block the worklet (it paces audio too): skip frames while one is encoding.
        self._frame_no += 1
        if self._state != "connected" or self._encoding or self._frame_no % self._stride:
            return
        self._encoding = True
        self._encode_task = asyncio.create_task(self._encode_and_emit(frame))

    async def push_audio_chunk(self, speech: SpeechBuffer) -> None:
        if speech.is_empty or self._state != "connected":
            return
        pcm = speech.resample(constant.NATIVE_SPEECH_SAMPLE_RATE).to_bytes()
        self._emit({"t": "a", "d": base64.b64encode(pcm).decode("ascii")})

    async def lines(self) -> AsyncIterator[bytes]:
        """The HTTP stream body. Marks the peer connected while it is consumed."""
        self._set_state("connected")
        if self._mic_task is None:
            self._mic_task = asyncio.create_task(self._mic_pacer())
        yield b'{"t":"state","s":"connected"}\n'
        try:
            while True:
                line = await self._out.get()
                if line is None:
                    return
                yield line
        finally:
            if self._state != "closed":
                self._set_state("disconnected")

    # ── inbound: watch microphone ─────────────────────────────────────────────
    def feed_mic(self, pcm: bytes, seq: int | None = None) -> bool:
        """A POSTed burst of 24 kHz s16 mono; `_mic_pacer` releases it in real time.

        `seq` (the watch numbers its POSTs): a burst arriving after a later one is dropped —
        spliced in out of order, speech turns into syllable salad Gemini hears as another
        language. Returns False when dropped.
        """
        if seq is not None:
            if seq <= self._mic_seq:
                PROBE.incr("watch.mic_out_of_order")
                return False
            if seq > self._mic_seq + 1 and self._mic_seq:
                PROBE.incr("watch.mic_gaps")
            self._mic_seq = seq
        self._mic += pcm[: len(pcm) - len(pcm) % 2]
        if len(self._mic) > _MIC_MAX_BYTES:
            del self._mic[: len(self._mic) - _MIC_MAX_BYTES]
        return True

    def _next_mic_chunk(self) -> bytes:
        if not self._mic_primed and len(self._mic) >= _MIC_PREBUFFER_BYTES:
            self._mic_primed = True
        if self._mic_primed and len(self._mic) >= _MIC_CHUNK_BYTES:
            chunk = bytes(self._mic[:_MIC_CHUNK_BYTES])
            del self._mic[:_MIC_CHUNK_BYTES]
            return chunk
        self._mic_primed = False  # underrun: re-buffer before resuming
        return _SILENCE

    def _push_inbound(self, chunk: bytes) -> None:
        if self._inbound.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self._inbound.get_nowait()
        arr = np.frombuffer(chunk, dtype=np.int16).copy()
        self._inbound.put_nowait(SpeechBuffer(arr, _MIC_RATE))

    async def _mic_pacer(self) -> None:
        """A continuous 20 ms mic stream, silence included — what WebRTC delivers."""
        loop = asyncio.get_running_loop()
        due = loop.time()
        while self._state not in ("closed", "failed"):
            self._push_inbound(self._next_mic_chunk())
            due += _MIC_CHUNK_S
            now = loop.time()
            if now - due > 0.2:  # the loop stalled: resync instead of bursting
                due = now
            await asyncio.sleep(max(0.0, due - now))

    async def recv_audio_chunk(self) -> SpeechBuffer:
        return await self._inbound.get()

    async def close(self) -> None:
        if self._state == "closed":
            return
        self._set_state("closed")
        self._out.put_nowait(None)
        if self._mic_task is not None:
            self._mic_task.cancel()
        self._encode_pool.shutdown(wait=False, cancel_futures=True)
