#!/usr/bin/env bash
# Downloads Liquid AI's LFM3-Audio GGUF model and audio projector for local realtime voice.
# Usage: ./scripts/setup_lfm.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="$ROOT_DIR/models/lfm"

mkdir -p "$MODELS_DIR"

MODEL_NAME="LFM3-Audio-2B-Q4_K_M.gguf"
PROJECTOR_NAME="mmproj-LFM3-Audio-2B-Q8_0.gguf"
REPO="LiquidAI/LFM3-Audio-2B-GGUF"

echo "=== Liquid AI LFM3-Audio Setup ==="
echo "Target directory: $MODELS_DIR"

# Check for huggingface-cli or curl
download_file() {
  local filename=$1
  local target="$MODELS_DIR/$filename"
  if [ -f "$target" ] && [ -s "$target" ]; then
    echo "✔ $filename already exists, skipping."
    return 0
  fi

  echo "Downloading $filename from $REPO..."
  if command -v hf >/dev/null 2>&1; then
    hf download "$REPO" "$filename" --local-dir "$MODELS_DIR"
  elif command -v huggingface-cli >/dev/null 2>&1; then
    huggingface-cli download "$REPO" "$filename" --local-dir "$MODELS_DIR"
  else
    local url="https://huggingface.co/$REPO/resolve/main/$filename"
    curl -L --progress-bar "$url" -o "$target"
  fi
}

download_file "$MODEL_NAME"
download_file "$PROJECTOR_NAME"

echo ""
echo "Liquid AI LFM3-Audio models ready in $MODELS_DIR"
echo "To start the local LFM Realtime server:"
echo "  ./scripts/start_lfm.sh"
