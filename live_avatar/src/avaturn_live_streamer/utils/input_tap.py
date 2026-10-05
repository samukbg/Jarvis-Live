"""The last minute of audio the streamer sent to Gemini Live, and what Gemini transcribed.

When Gemini mishears (French taken for Chinese), this tells whether the audio itself was
damaged before it left the server. Memory only, overwritten continuously; read with
GET /debug/input.wav (the audio) and GET /debug/input (segments + transcripts).
"""

import io
import threading
import time
import wave
from collections import deque

_RATE = 16_000
_MAX_BYTES = _RATE * 2 * 60  # 60 s of s16 mono


class InputTap:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._chunks: deque[tuple[float, str, bytes]] = deque()
        self._size = 0
        self._heard: deque[tuple[float, str, str]] = deque(maxlen=50)

    def add(self, stream_id: str, pcm16k: bytes) -> None:
        with self._lock:
            self._chunks.append((time.time(), stream_id, pcm16k))
            self._size += len(pcm16k)
            while self._size > _MAX_BYTES and self._chunks:
                self._size -= len(self._chunks.popleft()[2])

    def heard(self, stream_id: str, text: str) -> None:
        with self._lock:
            self._heard.append((time.time(), stream_id, text))

    def wav(self) -> bytes:
        with self._lock:
            pcm = b"".join(c[2] for c in self._chunks)
        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(_RATE)
            w.writeframes(pcm)
        return out.getvalue()

    def info(self) -> dict:
        with self._lock:
            chunks = list(self._chunks)
            heard = list(self._heard)
        segments: list[dict] = []
        for at, stream_id, pcm in chunks:
            if not segments or segments[-1]["stream"] != stream_id or at - segments[-1]["last"] > 2:
                segments.append({"stream": stream_id, "start": at, "last": at, "seconds": 0.0})
            segments[-1]["last"] = at
            segments[-1]["seconds"] += len(pcm) / 2 / _RATE
        return {
            "rate": _RATE,
            "seconds": sum(len(c[2]) for c in chunks) / 2 / _RATE,
            "segments": segments,
            "heard": [{"at": at, "stream": s, "text": t} for at, s, t in heard],
        }


INPUT_TAP = InputTap()
