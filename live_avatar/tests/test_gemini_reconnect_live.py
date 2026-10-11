"""GeminiApiClient against a fake Gemini Live: a 1011 drop mid-session reconnects with the
resumption handle and the user's audio keeps flowing; Shutdown ends it without reconnecting."""
import asyncio
import json
from pathlib import Path
import sys

import numpy as np
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from avaturn_live_streamer.conversation_engines import gemini_client  # noqa: E402
from avaturn_live_streamer.conversation_engines.configs import GeminiConversationEngineConfig  # noqa: E402
from avaturn_live_streamer.event_bus import EventBus  # noqa: E402
from avaturn_live_streamer.events import Shutdown, UserSpeechReceived  # noqa: E402
from avaturn_live_streamer.speech.speech_buffer import SpeechBuffer  # noqa: E402


def test_reconnects_after_a_1011_and_resumes_the_conversation(monkeypatch):
    setups: list[dict] = []
    audio_per_connection: list[int] = []

    async def fake_gemini(ws):
        setups.append(json.loads(await ws.recv())["setup"])
        await ws.send(json.dumps({"setupComplete": {}}))
        n = len(setups)
        await ws.send(json.dumps({"sessionResumptionUpdate": {"newHandle": f"handle-{n}", "resumable": True}}))
        audio_per_connection.append(0)
        async for raw in ws:
            if "realtimeInput" in json.loads(raw):
                audio_per_connection[-1] += 1
                if n == 1 and audio_per_connection[-1] == 3:
                    await ws.close(1011, "Internal error occurred.")
                    return

    async def run() -> None:
        async with websockets.serve(fake_gemini, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            monkeypatch.setattr(gemini_client, "_GEMINI_LIVE_URL", f"ws://127.0.0.1:{port}")
            client = gemini_client.GeminiApiClient(GeminiConversationEngineConfig(api_key="k", avatar_id="maria", enable_voice_conversion=False), stream_id="test")

            async def no_backend(*_a, **_k):
                return None
            monkeypatch.setattr(gemini_client.GeminiApiClient, "_fetch_installed_agents", no_backend)
            monkeypatch.setattr(gemini_client.GeminiApiClient, "_fetch_backend_tools", no_backend)

            bus = EventBus()
            task = asyncio.create_task(client.run(bus.clone(), None))
            bus.ready()
            chunk = SpeechBuffer(np.full(480, 2000, dtype=np.int16), 24000)
            for _ in range(12):
                await bus.publish(UserSpeechReceived(buffer=chunk))
                await asyncio.sleep(0.15)
            await bus.publish(Shutdown())
            await asyncio.wait_for(task, 5)

    asyncio.run(run())
    assert len(setups) == 2, "one reconnect after the 1011"
    assert "handle" not in setups[0]["sessionResumption"]
    assert setups[1]["sessionResumption"] == {"handle": "handle-1"}, "resumes the same conversation"
    assert audio_per_connection[0] == 3 and audio_per_connection[1] > 0, "audio flows again after reconnecting"
