#!/bin/bash
export PATH="/root/.pixi/bin:$PATH"
export STREAMER_HOST="0.0.0.0"
export STREAMER_PORT="8080"
export RENDERER_PORT="8000"
# GEMINI_API_KEY comes from the environment (or the streamer config): never commit it.
cd /root/avtr-1
pixi run -e streamer python scripts/run_local_stream.py
