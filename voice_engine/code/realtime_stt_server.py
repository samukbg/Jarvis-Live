"""
RealtimeSTT WebSocket Server — ws://localhost:8001

Accepts (from backend):
  {"type": "mute"}   — suppress transcripts while Jarvis is speaking
  {"type": "unmute"} — resume

Emits (to backend):
  {"type": "stt_partial", "text": "..."}  — live incremental update
  {"type": "stt_final",   "text": "..."}  — confirmed full sentence
  {"type": "stt_wake",    "text": "..."}  — wake word detected (Hi Jarvis / Wake up)
"""

import asyncio
import json
import re
import threading
import websockets
from RealtimeSTT import AudioToTextRecorder

# Wake words that activate Jarvis without needing the orb to be clicked.
# Strips the wake phrase and sends stt_wake; any trailing command is forwarded
# as stt_final so orchestration can pick it up.
_WAKE_RE = re.compile(
    r'^\s*(?:hi|hey|hello|good\s+morning|ok|okay|yo)\s+jarvis[,.]?\s*'
    r'|^\s*(?:wake\s+up|activate|jarvis)[,.]?\s*',
    re.IGNORECASE,
)

PORT = 8001
_clients: set = set()
_muted: threading.Event = threading.Event()
_wake_only: threading.Event = threading.Event()   # when set: only stt_wake passes through
_loop: asyncio.AbstractEventLoop | None = None
_recorder = None


def _safe_broadcast(msg: dict) -> None:
    """Call from any thread — schedules broadcast on the asyncio event loop."""
    if _loop is None:
        return
    if _muted.is_set():
        return
    # In wake_only mode suppress regular transcripts; wake words always pass.
    if _wake_only.is_set() and msg.get('type') != 'stt_wake':
        return
    asyncio.run_coroutine_threadsafe(_broadcast(msg), _loop)


async def _broadcast(msg: dict) -> None:
    dead = set()
    for ws in list(_clients):
        try:
            await ws.send(json.dumps(msg))
        except Exception:
            dead.add(ws)
    _clients.difference_update(dead)


async def _handler(ws) -> None:
    _clients.add(ws)
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                if msg.get("type") == "mute":
                    _muted.set()
                elif msg.get("type") == "unmute":
                    _muted.clear()
                elif msg.get("type") == "wake_only":
                    _wake_only.set()
                    _muted.clear()
                elif msg.get("type") == "full_mode":
                    _wake_only.clear()
                    _muted.clear()
                elif msg.get("type") == "set_language":
                    if _recorder is not None:
                        lang = msg.get("language", "en")
                        # Map 3-letter ISO-639-3 to 2-letter ISO-639-1 for faster-whisper
                        mapping = {"eng": "en", "fra": "fr", "deu": "de", "por": "pt", "ita": "it", "spa": "es", "cmn": "zh", "jpn": "ja", "kor": "ko"}
                        _recorder.language = mapping.get(lang, "en") if len(lang) > 2 else lang
                        print(f"[STT] Language switched to: {_recorder.language}")
            except Exception as e:
                print(f"[STT] Bad message: {e}")
    finally:
        _clients.discard(ws)


def _on_partial(text: str) -> None:
    _safe_broadcast({"type": "stt_partial", "text": text})


def _on_final(text: str) -> None:
    # Called from recorder thread — broadcast then return so recorder continues
    wake_match = _WAKE_RE.match(text)
    if wake_match:
        _safe_broadcast({"type": "stt_wake", "text": text})
        remainder = text[wake_match.end():].strip()
        if remainder:
            # Wake word followed by a command — forward the command part
            _safe_broadcast({"type": "stt_final", "text": remainder})
        return  # don't forward the raw wake phrase as a command
    _safe_broadcast({"type": "stt_final", "text": text})


def _recorder_loop() -> None:
    global _recorder
    _recorder = AudioToTextRecorder(
        model="small",
        language="en",
        enable_realtime_transcription=True,
        realtime_processing_pause=0.1,
        on_realtime_transcription_update=_on_partial,
        on_realtime_transcription_stabilized=_on_partial,
        silero_sensitivity=0.4,
        post_speech_silence_duration=0.7,   # 0.7s — middle ground (was 1.0, tried 0.5 too fast)
        min_length_of_recording=0.2,        # 0.2s (was 0.4) — catch short wake words
        spinner=False,
        no_log_file=True,                   # Prevent gigabytes of log files
        use_extended_logging=False,
    )
    print(f"[STT] AudioToTextRecorder started (model=small)")
    while True:
        try:
            _recorder.text(_on_final)
        except Exception as e:
            print(f"[STT] Recorder error: {e}")


async def main() -> None:
    global _loop
    _loop = asyncio.get_running_loop()

    t = threading.Thread(target=_recorder_loop, daemon=True)
    t.start()

    async with websockets.serve(_handler, "localhost", PORT):
        print(f"[STT] WebSocket server on ws://localhost:{PORT}")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
