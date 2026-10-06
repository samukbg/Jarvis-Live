"""The input tap keeps users' audio only when explicitly enabled (never on Jarvis Cloud)."""

from avaturn_live_streamer.utils.input_tap import InputTap


def test_disabled_tap_keeps_nothing():
    tap = InputTap(enabled=False)
    tap.add("s1", b"\x01\x00" * 1600)
    tap.heard("s1", "bonjour")
    assert tap.info()["seconds"] == 0
    assert tap.info()["heard"] == []


def test_enabled_tap_keeps_the_last_audio():
    tap = InputTap(enabled=True)
    tap.add("s1", b"\x01\x00" * 1600)
    tap.heard("s1", "bonjour")
    assert tap.info()["seconds"] == 0.1
    assert tap.info()["heard"][0]["text"] == "bonjour"
