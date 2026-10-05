import asyncio
import importlib.util
import os
import sys
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _xtts_helpers as helpers  # noqa: E402

# Load the module by path: importing the avtr1_renderer package pulls in torch.
_spec = importlib.util.spec_from_file_location(
    "xtts_worker_under_test",
    Path(__file__).resolve().parents[1] / "src" / "avtr1_renderer" / "api" / "xtts_worker.py",
)
xw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(xw)


def test_to_pcm16_scales_and_clips():
    pcm = xw.to_pcm16(np.array([0.0, 0.5, -0.5, 1.5, -1.5], dtype=np.float32))
    samples = np.frombuffer(pcm, dtype="<i2")
    assert samples.tolist() == [0, 16383, -16383, 32767, -32768]


def test_runs_in_a_separate_process():
    proc = xw.XttsProcess(initializer=None)
    try:
        worker_pid = asyncio.run(proc.call(helpers.pid))
        assert worker_pid != os.getpid()
    finally:
        proc.shutdown()


def test_replaces_a_crashed_worker_once(tmp_path):
    proc = xw.XttsProcess(initializer=None)
    try:
        assert asyncio.run(proc.call(helpers.crash_once, str(tmp_path / "marker"))) == "recovered"
    finally:
        proc.shutdown()


def test_gives_up_after_a_second_crash():
    proc = xw.XttsProcess(initializer=None)
    try:
        with pytest.raises(BrokenProcessPool):
            asyncio.run(proc.call(helpers.always_crash))
    finally:
        proc.shutdown()


def test_xtts_device_can_be_forced_to_the_cpu(monkeypatch):
    monkeypatch.setenv("XTTS_DEVICE", "CPU")
    assert xw._device() == "cpu"


def test_to_pcm16_accepts_half_precision_and_numpy():
    import numpy as np
    assert np.frombuffer(xw.to_pcm16(np.array([0.5], dtype=np.float16)), dtype="<i2").tolist() == [16383]
    assert np.frombuffer(xw.to_pcm16([0.25, -0.25]), dtype="<i2").tolist() == [8191, -8191]
