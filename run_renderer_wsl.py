import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'live_avatar' / 'src'))
from avaturn_live_streamer.wsl_distro import wsl_distro  # noqa: E402

cmd = [
    'wsl.exe',
    '-d',
    wsl_distro(),
    '-e',
    'bash',
    '-c',
    'cd /root/avtr-1 && export PYTHONPATH=src && export LOAD_BALANCER_URL=disabled && .pixi/envs/default/bin/python -m uvicorn avtr1_renderer.api.app:app --host 0.0.0.0 --port 8000'
]

print(f'[AVTR-1] Starting WSL2 Neural Renderer ({cmd[2]}) on port 8000...')
sys.stdout.flush()

try:
    p = subprocess.Popen(cmd)
    sys.exit(p.wait())
except Exception as e:
    print('[AVTR-1] Failed to start WSL renderer:', e)
    sys.exit(1)
