import asyncio
import io

import av
import numpy as np

from avaturn_live_streamer import constant
from avaturn_live_streamer.localrtc import watch_peer
from avaturn_live_streamer.localrtc.watch_peer import WatchPeer


def _landscape_frame() -> av.VideoFrame:
    img = np.zeros((720, 1280, 3), dtype=np.uint8)
    img[:, 620:660] = (255, 255, 255)  # a white stripe in the middle
    return av.VideoFrame.from_ndarray(img, format="bgr24").reformat(format="yuv420p")


def _decode(jpeg: bytes) -> av.VideoFrame:
    return next(av.open(io.BytesIO(jpeg), format="mjpeg").decode(video=0))


def test_crops_to_the_watch_screen_and_keeps_the_centre():
    peer = WatchPeer(width=416, height=496)
    jpeg = peer._encode(_landscape_frame())
    assert jpeg[:3] == b"\xff\xd8\xff"
    frame = _decode(jpeg)
    assert (frame.width, frame.height) == (416, 496)
    centre_column = frame.to_ndarray(format="rgb24")[:, 208].mean()
    assert centre_column > 200, "the middle of the video must stay in the middle of the watch"


def test_reuses_one_encoder_per_session():
    peer = WatchPeer(width=416, height=496)
    peer._encode(_landscape_frame())
    first = peer._encoder
    peer._encode(_landscape_frame())
    assert peer._encoder is first and first.thread_count == 1


def test_keeps_the_aspect_without_a_height():
    frame = _decode(WatchPeer(width=240)._encode(_landscape_frame()))
    assert (frame.width, frame.height) == (240, 134)


def test_sends_every_nth_frame_for_the_requested_fps(monkeypatch):
    async def run() -> int:
        peer = WatchPeer(fps=12, width=64)
        peer._state = "connected"
        encoded = []
        monkeypatch.setattr(peer, "_encode", lambda frame: encoded.append(frame) or b"jpeg")
        frame = _landscape_frame()
        for _ in range(constant.VIDEO_FPS):
            await peer.push_video_frame(frame)
            if peer._encode_task:
                await peer._encode_task  # each encode finishes before the next frame
        return len(encoded)

    assert asyncio.run(run()) == 12  # 25 fps in → every 2nd frame


def test_skips_frames_while_one_is_encoding(monkeypatch):
    async def run() -> int:
        peer = WatchPeer(fps=25, width=64)
        peer._state = "connected"
        calls = []
        monkeypatch.setattr(peer, "_encode", lambda frame: calls.append(1) or b"jpeg")
        for _ in range(10):
            await peer.push_video_frame(_landscape_frame())  # no await in between: one in flight
        await peer._encode_task
        return len(calls)

    assert asyncio.run(run()) == 1


def test_mic_becomes_a_continuous_20ms_stream():
    async def run() -> list[int]:
        peer = WatchPeer()
        peer._state = "connected"
        task = asyncio.create_task(peer._mic_pacer())
        await asyncio.sleep(0.1)  # silence before anything is posted
        peer.feed_mic(np.full(4800, 1000, dtype=np.int16).tobytes())  # one 200 ms burst
        await asyncio.sleep(0.45)
        peer._state = "closed"
        task.cancel()
        chunks = []
        while not peer._inbound.empty():
            chunks.append(peer._inbound.get_nowait())
        return [int(abs(c._buffer).max()) for c in chunks if len(c._buffer) == constant.NATIVE_SPEECH_SAMPLE_RATE // 50]

    peaks = asyncio.run(run())
    assert len(peaks) >= 20, "a chunk every 20 ms, silence included"
    assert peaks[0] == 0 and 1000 in peaks
    assert sum(p == 1000 for p in peaks) == 10, "the 200 ms burst comes out as ten 20 ms chunks"


def test_quality_maps_to_qscale():
    assert watch_peer._jpeg_qscale(100) == 2
    assert watch_peer._jpeg_qscale(1) == 31


def test_module_does_not_need_opencv():
    assert "import cv2" not in open(watch_peer.__file__).read()
