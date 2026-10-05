import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from avaturn_live_streamer.local_stream_cli import _SessionSlot  # noqa: E402


def test_a_new_session_preempts_the_old_one_without_failing():
    async def run() -> bool:
        slot = _SessionSlot()
        slot.attach(asyncio.create_task(asyncio.sleep(3600)))
        await slot.claim()  # used to raise CancelledError → HTTP 500 on /offer
        return slot.busy

    assert asyncio.run(run()) is False
