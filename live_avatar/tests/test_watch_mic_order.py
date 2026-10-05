from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from avaturn_live_streamer.localrtc.watch_peer import WatchPeer  # noqa: E402


def test_late_mic_bursts_are_dropped_not_spliced_in():
    peer = WatchPeer()
    assert peer.feed_mic(b"\x01\x00" * 10, seq=1)
    assert peer.feed_mic(b"\x03\x00" * 10, seq=3)
    assert not peer.feed_mic(b"\x02\x00" * 10, seq=2), "arrived after 3: would shuffle the speech"
    assert not peer.feed_mic(b"\x03\x00" * 10, seq=3), "duplicate"
    assert bytes(peer._mic) == b"\x01\x00" * 10 + b"\x03\x00" * 10


def test_unnumbered_bursts_still_work():
    peer = WatchPeer()
    assert peer.feed_mic(b"\x01\x00" * 4)
    assert peer.feed_mic(b"\x02\x00" * 4)
    assert len(peer._mic) == 16
