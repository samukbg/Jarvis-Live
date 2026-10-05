"""Functions run inside the spawned worker by test_xtts_worker (must be importable by name)."""

import os
from pathlib import Path


def pid() -> int:
    return os.getpid()


def crash_once(marker: str) -> str:
    """Kills the worker the first time it is called, succeeds on the next worker."""
    m = Path(marker)
    if not m.exists():
        m.write_text("crashed")
        os._exit(1)
    return "recovered"


def always_crash() -> None:
    os._exit(1)
