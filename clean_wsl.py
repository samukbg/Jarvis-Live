import subprocess

# Run by boot.bat before it starts Jarvis: shut WSL down completely so the AVTR-1
# renderer starts on a clean GPU. Killing the old renderer process by process
# (fuser/pkill) left something on the GPU: the new renderer then hung at startup or
# rendered ~4x slower (avatar black or at 4 fps) until `wsl --shutdown`, which always
# came back clean (2026-10-01). This restarts every WSL distro on the machine.
try:
    subprocess.run(["wsl", "--shutdown"], timeout=60, capture_output=True)
except Exception:
    pass
