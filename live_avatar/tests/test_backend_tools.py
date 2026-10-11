"""Backend tools for the avatar's Gemini session (GET /api/device/tool): show_business_dashboard
is declared from the backend's list, its calls are posted back to the backend path, and an older
backend (no `tools` field, or 404 on the path) degrades to "not available"."""
import asyncio
import json
from pathlib import Path
import sys
import types

import httpx
import numpy as np
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from avaturn_live_streamer.conversation_engines import gemini_client  # noqa: E402
from avaturn_live_streamer.conversation_engines.configs import GeminiConversationEngineConfig  # noqa: E402
from avaturn_live_streamer.event_bus import EventBus  # noqa: E402
from avaturn_live_streamer.events import Shutdown, UserSpeechReceived  # noqa: E402
from avaturn_live_streamer.speech.speech_buffer import SpeechBuffer  # noqa: E402
from avaturn_live_streamer.vision import VisionFrameBox  # noqa: E402

PHONE = {"name": "phone_action", "description": "phone", "parameters": {"type": "OBJECT", "properties": {}}}
BUSINESS = {"name": "show_business_dashboard", "description": "dashboard", "parameters": {"type": "OBJECT", "properties": {"name": {"type": "STRING"}}}}


def _mock_http(monkeypatch, handler):
    real = httpx.AsyncClient
    monkeypatch.setattr(gemini_client.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


def _engine(bases=("http://backend",)):
    return types.SimpleNamespace(_backend_targets=lambda: (list(bases), {"x-api-key": "k"}))


def test_newer_backend_lists_the_business_tool_with_its_path(monkeypatch):
    def handler(req):
        assert req.headers["x-api-key"] == "k"
        return httpx.Response(200, json={"tool": PHONE, "prompt": "P", "tools": [
            {"tool": BUSINESS, "prompt": "B", "path": "/api/business/show"},
            {"tool": {"name": "evil"}, "path": "https://elsewhere/x"},  # not a backend path: ignored
        ]})
    _mock_http(monkeypatch, handler)
    tools = asyncio.run(gemini_client.GeminiApiClient._fetch_backend_tools(_engine()))
    assert [t["tool"]["name"] for t in tools] == ["phone_action", "show_business_dashboard"]
    assert tools[1]["path"] == "/api/business/show" and "path" not in tools[0]


def test_older_backend_has_the_phone_tool_only(monkeypatch):
    _mock_http(monkeypatch, lambda req: httpx.Response(200, json={"tool": PHONE, "prompt": "P"}))
    tools = asyncio.run(gemini_client.GeminiApiClient._fetch_backend_tools(_engine()))
    assert [t["tool"]["name"] for t in tools] == ["phone_action"]


def test_the_call_goes_back_to_the_backend_and_its_result_is_spoken(monkeypatch):
    seen = {}

    def handler(req):
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"ok": True, "result": "Spread Out is thriving."})
    _mock_http(monkeypatch, handler)
    out = asyncio.run(gemini_client.GeminiApiClient._execute_backend_tool(_engine(), "/api/business/show", {"name": "Spread Out"}))
    assert out == "Spread Out is thriving."
    assert seen["url"] == "http://backend/api/business/show"
    assert seen["body"] == {"name": "Spread Out", "via": "avatar"}


def test_a_backend_without_the_route_says_it_is_unavailable(monkeypatch):
    _mock_http(monkeypatch, lambda req: httpx.Response(404, json={"error": "nope"}))
    out = asyncio.run(gemini_client.GeminiApiClient._execute_backend_tool(_engine(), "/api/business/show", {}))
    assert "not available" in out


def test_no_backend_reachable_says_so(monkeypatch):
    def handler(req):
        raise httpx.ConnectError("refused")
    _mock_http(monkeypatch, handler)
    out = asyncio.run(gemini_client.GeminiApiClient._execute_backend_tool(_engine(("http://a", "http://b")), "/api/business/show", {}))
    assert "Could not reach" in out


def test_session_declares_the_tool_and_answers_its_call(monkeypatch):
    setups: list[dict] = []
    responses: list[dict] = []
    calls: list[tuple] = []

    async def fake_gemini(ws):
        setups.append(json.loads(await ws.recv())["setup"])
        await ws.send(json.dumps({"setupComplete": {}}))
        await ws.send(json.dumps({"toolCall": {"functionCalls": [{"id": "c1", "name": "show_business_dashboard", "args": {"name": "VTO"}}]}}))
        async for raw in ws:
            msg = json.loads(raw)
            if "toolResponse" in msg:
                responses.append(msg["toolResponse"])

    async def run() -> None:
        async with websockets.serve(fake_gemini, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            monkeypatch.setattr(gemini_client, "_GEMINI_LIVE_URL", f"ws://127.0.0.1:{port}")
            # The shared frame box's asyncio.Event binds to the first event loop that waits on it:
            # a box of our own, so the other session tests still get a fresh one.
            monkeypatch.setattr(gemini_client, "VISION", VisionFrameBox())
            client = gemini_client.GeminiApiClient(GeminiConversationEngineConfig(api_key="k", avatar_id="maria", enable_voice_conversion=False), stream_id="test")

            async def no_agents(*_a, **_k):
                return None

            async def backend_tools(*_a, **_k):
                return [{"tool": PHONE, "prompt": "PHONE RULES"}, {"tool": BUSINESS, "prompt": "BUSINESS RULES", "path": "/api/business/show"}]

            async def execute(_self, path, args):
                calls.append((path, args))
                return "VTO is steady."
            monkeypatch.setattr(gemini_client.GeminiApiClient, "_fetch_installed_agents", no_agents)
            monkeypatch.setattr(gemini_client.GeminiApiClient, "_fetch_backend_tools", backend_tools)
            monkeypatch.setattr(gemini_client.GeminiApiClient, "_execute_backend_tool", execute)

            bus = EventBus()
            task = asyncio.create_task(client.run(bus.clone(), None))
            bus.ready()
            chunk = SpeechBuffer(np.full(480, 2000, dtype=np.int16), 24000)
            for _ in range(8):
                await bus.publish(UserSpeechReceived(buffer=chunk))
                await asyncio.sleep(0.1)
                if responses:
                    break
            await bus.publish(Shutdown())
            await asyncio.wait_for(task, 5)

    asyncio.run(run())
    names = [d["name"] for t in setups[0]["tools"] for d in t.get("functionDeclarations", [])]
    assert "show_business_dashboard" in names and "phone_action" in names
    assert "BUSINESS RULES" in setups[0]["systemInstruction"]["parts"][0]["text"]
    assert calls == [("/api/business/show", {"name": "VTO"})]
    assert responses[0]["functionResponses"] == [{"id": "c1", "name": "show_business_dashboard", "response": {"result": "VTO is steady."}}]
