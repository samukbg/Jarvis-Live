"""The WSL distro that runs the AVTR-1 renderer on this machine.

JARVIS_WSL_DISTRO wins (boot.bat sets it); otherwise the first common distro name that
has /root/avtr-1.
"""

import os
from functools import lru_cache
from pathlib import Path

CANDIDATES = ("Ubuntu", "Ubuntu-24.04", "Ubuntu-22.04", "Debian")


@lru_cache(maxsize=1)
def wsl_distro() -> str:
    configured = os.environ.get("JARVIS_WSL_DISTRO", "").strip()
    if configured:
        return configured
    for name in CANDIDATES:
        for root in (rf"\\wsl.localhost\{name}", rf"\\wsl$\{name}"):
            try:
                if (Path(root) / "root" / "avtr-1").exists():
                    return name
            except OSError:
                pass
    return CANDIDATES[0]


def wsl_unc_roots() -> list[str]:
    """UNC roots of the distro's filesystem, as seen from Windows."""
    name = wsl_distro()
    return [rf"\\wsl.localhost\{name}", rf"\\wsl$\{name}"]
