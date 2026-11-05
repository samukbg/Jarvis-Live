#!/usr/bin/env bash
# Starts llama.cpp realtime server with LFM3-Audio on port 9931.
# Compatible with OpenAI Realtime protocol.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="$ROOT_DIR/models/lfm"

MODEL_FILE="$MODELS_DIR/LFM3-Audio-2B-Q4_K_M.gguf"
PROJECTOR_FILE="$MODELS_DIR/mmproj-LFM3-Audio-2B-Q8_0.gguf"
PORT="${LFM_PORT:-9931}"
HOST="${LFM_HOST:-127.0.0.1}"

# Also check scratch dir for quick developer trials
if [ ! -f "$MODEL_FILE" ] && [ -f "$ROOT_DIR/scratch/lfm/LFM3-Audio-2B-Q4_K_M.gguf" ]; then
  MODEL_FILE="$ROOT_DIR/scratch/lfm/LFM3-Audio-2B-Q4_K_M.gguf"
  PROJECTOR_FILE="$ROOT_DIR/scratch/lfm/mmproj-LFM3-Audio-2B-Q8_0.gguf"
fi

if [ ! -f "$MODEL_FILE" ] || [ ! -f "$PROJECTOR_FILE" ]; then
  echo "Error: LFM models not found."
  echo "Run ./scripts/setup_lfm.sh first to download them."
  exit 1
fi

LLAMA_CMD=""
if command -v llama >/dev/null 2>&1; then
  LLAMA_CMD="llama serve"
elif command -v llama-server >/dev/null 2>&1; then
  LLAMA_CMD="llama-server"
else
  echo "Error: llama.cpp server not found (neither 'llama' nor 'llama-server' in PATH)."
  echo "Install via: brew install llama.cpp, or build from source."
  exit 1
fi

echo "Starting Liquid AI LFM3-Audio server on ws://$HOST:$PORT/v1/realtime..."
exec $LLAMA_CMD \
  -m "$MODEL_FILE" \
  -mm "$PROJECTOR_FILE" \
  --host "$HOST" \
  --port "$PORT" \
  --jinja
