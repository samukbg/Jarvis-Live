import os
import sys
from pathlib import Path
from dotenv import load_dotenv

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
os.environ["PYTHONIOENCODING"] = "utf-8"
os.environ["PYTHONUTF8"] = "1"

LIVE_AVATAR_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = LIVE_AVATAR_DIR.parent
SRC_DIR = LIVE_AVATAR_DIR / "src"
sys.path.insert(0, str(SRC_DIR))

from avaturn_live_streamer.wsl_distro import wsl_distro  # noqa: E402

# Load .env
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(LIVE_AVATAR_DIR / ".env")

def _ipv4s(out: str) -> list[str]:
    """The IPv4 addresses in `hostname -I` output. When WSL fails, wsl.exe prints its error in
    UTF-16 (null characters) instead, which crashed the streamer as an environment value."""
    import re
    return re.findall(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", (out or "").replace("\x00", ""))


def get_wsl_renderer_url() -> str:
    import subprocess, httpx
    if os.environ.get("RENDERER_URL"):
        return os.environ["RENDERER_URL"]
    
    try:
        res = subprocess.run(["wsl.exe", "-d", wsl_distro(), "-e", "hostname", "-I"], capture_output=True, text=True, timeout=3)
        for ip in _ipv4s(res.stdout):
            url = f"http://{ip}:8000"
            try:
                if httpx.get(f"{url}/avatars", timeout=1.5).status_code == 200:
                    return url
            except Exception:
                pass
    except Exception:
        pass

    try:
        if httpx.get("http://127.0.0.1:8000/avatars", timeout=1.0).status_code == 200:
            return "http://127.0.0.1:8000"
    except Exception:
        pass

    try:
        res = subprocess.run(["wsl.exe", "-d", wsl_distro(), "-e", "hostname", "-I"], capture_output=True, text=True, timeout=2)
        ips = _ipv4s(res.stdout)
        if ips:
            return f"http://{ips[0]}:8000"
    except Exception:
        pass

    return "http://127.0.0.1:8000"

renderer_url = get_wsl_renderer_url()
os.environ["RENDERER_URL"] = renderer_url
os.environ["RENDERERS__RENDERERS__AVTRN_1__MODE"] = "single"
os.environ["RENDERERS__RENDERERS__AVTRN_1__LB_OR_INSTANCE_URL"] = renderer_url
print(f"Connecting to WSL2 GPU Renderer at: {renderer_url}")

from avaturn_live_streamer.local_stream_cli import _make_app
import uvicorn

if __name__ == "__main__":
    app = _make_app(idle_timeout=30, max_duration=3600)
    host = os.environ.get("STREAMER_HOST", "0.0.0.0")
    port = int(os.environ.get("STREAMER_PORT", "7860"))
    print(f"Starting Native Windows Live Avatar WebRTC Streamer on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
