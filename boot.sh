#!/usr/bin/env bash
# Jarvis Live: start everything on macOS / Linux.
#   web client  http://localhost:11433  (Vite dev server, proxies /api and /ws to the backend)
#   backend     http://localhost:4000
#   STT         ws://localhost:8001     (only if voice_engine/venv exists)
#   live avatar http://localhost:7860   (only if the AVTR-1 streamer is installed)
# Ctrl+C stops only the processes this script started.
set -u
cd "$(dirname "$0")"

CYAN='\033[0;36m'; YELLOW='\033[0;33m'; NC='\033[0m'
say()  { echo -e "${CYAN}> $*${NC}"; }
warn() { echo -e "${YELLOW}! $*${NC}"; }

PIDS=()
cleanup() {
  echo; say "Shutting down Jarvis..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM

busy() { lsof -ti ":$1" -sTCP:LISTEN >/dev/null 2>&1; }
for port in 4000 11433; do
  if busy "$port"; then warn "Port $port is already in use. Stop whatever is using it (or a previous Jarvis) first."; exit 1; fi
done

[ -f .env ] || warn "No .env found: copy .env.example to .env and set API_KEY and GEMINI_API_KEY."
[ -d node_modules ] || { say "Installing web client dependencies..."; npm install --no-fund --no-audit; }
[ -d backend/node_modules ] || { say "Installing backend dependencies..."; (cd backend && npm install --no-fund --no-audit); }

# Speech-to-text (optional)
if [ -x voice_engine/venv/bin/python ]; then
  say "Starting RealtimeSTT (port 8001)..."
  (cd voice_engine/code && ../venv/bin/python realtime_stt_server.py > ../../stt.log 2>&1) &
  PIDS+=($!)
else
  warn "Speech-to-text off (see README → Voice: python -m venv voice_engine/venv)."
fi

# Live avatar (optional, needs an NVIDIA GPU)
if [ -d live_avatar/.pixi ]; then
  say "Starting the AVTR-1 live avatar streamer (port 7860)..."
  (cd live_avatar && pixi run interactive-demo > ../live_avatar.log 2>&1) &
  PIDS+=($!)
else
  warn "Live avatar off (see README → Live avatar)."
fi

say "Starting the Jarvis backend (port 4000)..."
(cd backend && npm start > ../backend.log 2>&1) &
PIDS+=($!)

say "Starting the web client (port 11433)..."
npm run dev > frontend.log 2>&1 &
PIDS+=($!)

echo -e "${CYAN}------------------------------------------------${NC}"
echo -e "${CYAN}Jarvis is online:  http://localhost:11433${NC}"
echo -e "${CYAN}Logs: backend.log, frontend.log, stt.log, live_avatar.log${NC}"
echo -e "${CYAN}Press Ctrl+C to stop.${NC}"
wait
