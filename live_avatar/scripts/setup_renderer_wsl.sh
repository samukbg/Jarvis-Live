#!/usr/bin/env bash
# Sets up the AVTR-1 renderer in this WSL distro (/root/avtr-1, port 8000).
# Run by live_avatar/setup_avatar_windows.bat; safe to re-run (finished steps are skipped).
# Needs HF_TOKEN (HuggingFace, access to the AVTR-1 models) the first time, for the download.
set -euo pipefail
cd /root/avtr-1
export PATH="$HOME/.pixi/bin:$PATH"

nvidia-smi >/dev/null 2>&1 || { echo "No NVIDIA GPU visible in WSL - update the NVIDIA driver on Windows."; exit 1; }

if ! command -v pixi >/dev/null 2>&1; then
  echo "> Installing pixi..."
  curl -fsSL https://pixi.sh/install.sh | bash
fi

# The renderer runs from the default env (run_renderer_wsl.py: .pixi/envs/default).
echo "> Installing the renderer environment (torch, TensorRT - a few GB, first time only)..."
pixi install

if [ ! -f artifacts/.download_complete ]; then
  if [ -z "${HF_TOKEN:-}" ] && ! pixi run hf auth whoami >/dev/null 2>&1; then
    echo "Model download needs a HuggingFace token: set HF_TOKEN=hf_... and run the setup again."
    exit 2
  fi
  echo "> Downloading model artifacts..."
  pixi run python scripts/download_artifacts.py --workers 8
  touch artifacts/.download_complete
fi

# Keep the token so boot can fetch new avatar portraits later (the HF repo is gated).
if [ -n "${HF_TOKEN:-}" ]; then
  pixi run python -c "import os; from huggingface_hub import login; login(token=os.environ['HF_TOKEN'])" >/dev/null 2>&1 || true
fi
# The download skips reference_frames when the folder already exists: add what's missing.
pixi run python scripts/fetch_avatar_portraits.py || true

# TensorRT engines are specific to the GPU, so they are built here (10-30 min).
if [ ! -f artifacts/.engines_built ]; then
  echo "> Building TensorRT engines for this GPU..."
  pixi run -e renderer python scripts/build_engines.py
  touch artifacts/.engines_built
fi

echo "> AVTR-1 renderer ready in /root/avtr-1."
