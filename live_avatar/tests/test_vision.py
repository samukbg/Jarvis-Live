import asyncio

import pytest

from avaturn_live_streamer.vision import VisionFrameBox


def test_latest_frame_wins():
    async def scenario():
        box = VisionFrameBox()
        box.publish("image/jpeg", "old")
        box.publish("image/jpeg", "new")
        return await asyncio.wait_for(box.next(), 1)

    assert asyncio.run(scenario()) == ("image/jpeg", "new")


def test_next_waits_for_a_frame():
    async def scenario():
        box = VisionFrameBox()
        waiter = asyncio.create_task(box.next())
        await asyncio.sleep(0.01)
        assert not waiter.done()
        box.publish("image/png", "abc")
        return await asyncio.wait_for(waiter, 1)

    assert asyncio.run(scenario()) == ("image/png", "abc")


def test_rejects_non_images_and_oversized_frames():
    box = VisionFrameBox(max_bytes=10)
    with pytest.raises(ValueError):
        box.publish("text/plain", "abc")
    with pytest.raises(ValueError):
        box.publish("image/jpeg", "x" * 11)
