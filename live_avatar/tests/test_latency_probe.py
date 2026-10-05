import threading

from pytest import approx

from avaturn_live_streamer.utils.latency_probe import LatencyProbe


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def test_percentiles_use_nearest_rank():
    p = LatencyProbe()
    for v in range(1, 101):
        p.record("x", float(v))
    m = p.snapshot()["metrics"]["x"]
    assert m["count"] == 100
    assert m["p50"] == 50.0
    assert m["p95"] == 95.0
    assert m["max"] == 100.0
    assert m["last"] == 100.0


def test_window_keeps_only_recent_samples():
    p = LatencyProbe(window=3)
    for v in (100.0, 1.0, 2.0, 3.0):
        p.record("x", v)
    m = p.snapshot()["metrics"]["x"]
    assert m["count"] == 3
    assert m["max"] == 3.0
    assert m["total"] == 4


def test_counters_and_info():
    p = LatencyProbe()
    p.incr("drops")
    p.incr("drops", 2)
    p.set_info("codec", "h264")
    snap = p.snapshot()
    assert snap["counters"]["drops"] == 3
    assert snap["info"]["codec"] == "h264"


def test_since_records_once_per_mark():
    clock = FakeClock()
    p = LatencyProbe(clock=clock)
    assert p.since("eos", "resp") is None  # never marked
    p.mark("eos")
    clock.t = 0.25
    assert p.since("eos", "resp") == approx(250.0)
    clock.t = 0.5
    assert p.since("eos", "resp") is None  # already consumed for this mark
    p.mark("eos")  # re-arm
    clock.t = 0.6
    assert p.since("eos", "resp") == approx(100.0)
    assert p.snapshot()["metrics"]["resp"]["count"] == 2


def test_since_tracks_each_metric_independently():
    clock = FakeClock()
    p = LatencyProbe(clock=clock)
    p.mark("eos")
    clock.t = 0.1
    assert p.since("eos", "a") == approx(100.0)
    clock.t = 0.3
    assert p.since("eos", "b") == approx(300.0)


def test_timed_context_records_elapsed_ms():
    clock = FakeClock()
    p = LatencyProbe(clock=clock)
    with p.timed("work"):
        clock.t = 0.042
    assert p.snapshot()["metrics"]["work"]["last"] == approx(42.0)


def test_timed_records_even_when_body_raises():
    clock = FakeClock()
    p = LatencyProbe(clock=clock)
    try:
        with p.timed("work"):
            clock.t = 0.01
            raise ValueError
    except ValueError:
        pass
    assert p.snapshot()["metrics"]["work"]["count"] == 1


def test_reset_clears_metrics_counters_and_marks_but_keeps_info():
    p = LatencyProbe()
    p.record("x", 1.0)
    p.incr("c")
    p.mark("m")
    p.set_info("k", "v")
    p.reset()
    snap = p.snapshot()
    assert snap["metrics"] == {} and snap["counters"] == {}
    assert snap["info"] == {"k": "v"}
    assert p.since("m", "x") is None


def test_format_report_lists_every_metric_and_counter():
    p = LatencyProbe()
    p.record("renderer.call_ms", 12.5)
    p.incr("rtc.frames_late")
    report = p.format_report("AVATAR LATENCY REPORT")
    assert "=== AVATAR LATENCY REPORT ===" in report
    assert "renderer.call_ms" in report
    assert "rtc.frames_late" in report


def test_concurrent_records_are_not_lost():
    p = LatencyProbe(window=100_000)

    def worker():
        for _ in range(1000):
            p.record("x", 1.0)
            p.incr("n")

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    snap = p.snapshot()
    assert snap["metrics"]["x"]["total"] == 8000
    assert snap["counters"]["n"] == 8000
