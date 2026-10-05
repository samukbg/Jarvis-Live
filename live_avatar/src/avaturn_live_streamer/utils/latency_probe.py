# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""In-process latency probe (stdlib only).

Shared by the streamer and the renderer so a profiling session can be read back
from ``GET /debug/latency`` without an OpenTelemetry SDK/exporter. Metrics keep a
rolling window of recent samples (milliseconds); counters are plain totals.

Marks give one-shot per-turn latencies: ``mark("user_eos")`` stamps the time and
re-arms, ``since("user_eos", "resp.x_ms")`` records ``now - mark`` only the first
time it is called for that metric after each mark.

Thread-safe: samples arrive from the event loop, ``run_in_thread`` workers and
aiortc's encoder executor.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any


def _percentile(sorted_values: list[float], p: float) -> float:
    """Nearest-rank percentile of an already sorted, non-empty list."""
    idx = max(0, math.ceil(p / 100.0 * len(sorted_values)) - 1)
    return sorted_values[idx]


class LatencyProbe:
    def __init__(self, window: int = 2000, clock: Callable[[], float] = time.perf_counter):
        self._window = window
        self._clock = clock
        self._lock = threading.Lock()
        self._samples: dict[str, deque[float]] = {}
        self._totals: dict[str, int] = {}
        self._counters: dict[str, int] = {}
        self._marks: dict[str, float] = {}
        self._consumed: dict[str, set[str]] = {}
        self._info: dict[str, Any] = {}

    def record(self, name: str, value_ms: float) -> None:
        with self._lock:
            buf = self._samples.get(name)
            if buf is None:
                buf = self._samples[name] = deque(maxlen=self._window)
            buf.append(float(value_ms))
            self._totals[name] = self._totals.get(name, 0) + 1

    def incr(self, name: str, n: int = 1) -> None:
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + n

    def set_info(self, key: str, value: Any) -> None:
        with self._lock:
            self._info[key] = value

    def mark(self, name: str) -> None:
        with self._lock:
            self._marks[name] = self._clock()
            self._consumed[name] = set()

    def since(self, mark: str, metric: str) -> float | None:
        """Record ms elapsed since ``mark`` once per arm; returns the value or None."""
        with self._lock:
            at = self._marks.get(mark)
            consumed = self._consumed.get(mark)
            if at is None or consumed is None or metric in consumed:
                return None
            consumed.add(metric)
            elapsed_ms = (self._clock() - at) * 1000.0
        self.record(metric, elapsed_ms)
        return elapsed_ms

    @contextmanager
    def timed(self, name: str) -> Iterator[None]:
        start = self._clock()
        try:
            yield
        finally:
            self.record(name, (self._clock() - start) * 1000.0)

    def reset(self) -> None:
        with self._lock:
            self._samples.clear()
            self._totals.clear()
            self._counters.clear()
            self._marks.clear()
            self._consumed.clear()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            samples = {k: sorted(v) for k, v in self._samples.items() if v}
            lasts = {k: v[-1] for k, v in self._samples.items() if v}
            totals = dict(self._totals)
            counters = dict(self._counters)
            info = dict(self._info)
        metrics = {
            name: {
                "count": len(vals),
                "total": totals.get(name, len(vals)),
                "p50": round(_percentile(vals, 50), 2),
                "p95": round(_percentile(vals, 95), 2),
                "max": round(vals[-1], 2),
                "last": round(lasts[name], 2),
            }
            for name, vals in sorted(samples.items())
        }
        return {"metrics": metrics, "counters": dict(sorted(counters.items())), "info": info}

    def format_report(self, title: str) -> str:
        snap = self.snapshot()
        lines = [f"=== {title} ==="]
        for name, m in snap["metrics"].items():
            lines.append(
                f"  {name:<44} n={m['count']:<5} p50={m['p50']:>9.1f} "
                f"p95={m['p95']:>9.1f} max={m['max']:>9.1f}"
            )
        for name, v in snap["counters"].items():
            lines.append(f"  {name:<44} {v}")
        for key, v in snap["info"].items():
            lines.append(f"  info.{key:<39} {v}")
        lines.append("=" * (len(title) + 8))
        return "\n".join(lines)


PROBE = LatencyProbe()

# int16 RMS above which a mic/avatar audio chunk counts as speech (~ -36 dBFS).
VOICED_RMS = 500.0

# Mark stamped on every voiced inbound user chunk; per-turn response latencies
# are measured from the last one.
USER_VOICE_MARK = "user_voice"
