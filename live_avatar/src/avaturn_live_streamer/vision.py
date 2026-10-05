# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Camera / screen frames for the live Gemini session.

The phone's camera and screen share reach the streamer over HTTP (via the Jarvis
backend); the active GeminiApiClient forwards them as realtime video input. Only
the latest frame matters, so a newer frame replaces one not yet sent.
"""

import asyncio


class VisionFrameBox:
    def __init__(self, max_bytes: int = 2_000_000) -> None:
        self._max_bytes = max_bytes
        self._frame: tuple[str, str] | None = None
        self._event = asyncio.Event()

    def publish(self, mime_type: str, data_b64: str) -> None:
        if not mime_type.startswith("image/"):
            raise ValueError(f"unsupported vision frame type: {mime_type}")
        if len(data_b64) > self._max_bytes:
            raise ValueError("vision frame too large")
        self._frame = (mime_type, data_b64)
        self._event.set()

    async def next(self) -> tuple[str, str]:
        while True:
            await self._event.wait()
            self._event.clear()
            if self._frame is not None:
                frame, self._frame = self._frame, None
                return frame


VISION = VisionFrameBox()
