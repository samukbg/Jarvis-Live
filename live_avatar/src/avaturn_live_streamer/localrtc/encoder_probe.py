# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Times aiortc's outbound video encoders for the latency probe.

aiortc runs ``Encoder.encode`` on its executor for every outbound frame; with
libx264 at 720p that software encode is a prime stutter suspect. The patch wraps
``encode`` on the H.264 and VP8 encoder classes, records ``rtc.encode_ms`` and
the negotiated codec, and otherwise returns/raises exactly what the original does.
"""

import functools

from avaturn_live_streamer.core.logs import get_logger
from avaturn_live_streamer.utils.latency_probe import PROBE

_LOGGER = get_logger()
_INSTALLED = False


def _wrap(cls: type, codec: str) -> None:
    original = cls.encode

    @functools.wraps(original)
    def encode(self, frame, force_keyframe=False):
        PROBE.set_info("rtc.video_codec", codec)
        with PROBE.timed("rtc.encode_ms"):
            return original(self, frame, force_keyframe)

    cls.encode = encode


def install_encoder_probe() -> None:
    """Idempotently patch aiortc's video encoders. Never raises."""
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True
    try:
        from aiortc.codecs.h264 import H264Encoder
        from aiortc.codecs.vpx import Vp8Encoder

        _wrap(H264Encoder, "h264/libx264")
        _wrap(Vp8Encoder, "vp8/libvpx")
    except Exception:
        _LOGGER.warning("Could not install aiortc encoder probe", exc_info=True)
