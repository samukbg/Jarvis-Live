import asyncio
from pathlib import Path
import sys

import httpx
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from avaturn_live_streamer.conversation_engines import gemini_client  # noqa: E402
from avaturn_live_streamer.conversation_engines.configs import GeminiConversationEngineConfig  # noqa: E402
from avaturn_live_streamer.speech import hybrid_voice_synthesizer as hvs  # noqa: E402


def client(avatar: str) -> gemini_client.GeminiApiClient:
    return gemini_client.GeminiApiClient(GeminiConversationEngineConfig(api_key="k", avatar_id=avatar), stream_id="t")


def test_builtin_avatars_use_gemini_voice_even_with_latents_on_disk(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "reference_voices").mkdir()
    for av in ("maria", "alice"):
        (tmp_path / "reference_voices" / f"{av}_latents.pt").write_bytes(b"x")
    assert client("maria")._is_hybrid_clone is False, "built-in: Gemini's own voice, streamed"
    assert client("bob")._is_hybrid_clone is False, "no recording: Gemini voice"
    assert client("alice")._is_hybrid_clone is True, "a real person's recording stays cloned"


def test_streams_exact_20ms_chunks_from_uneven_network_pieces(monkeypatch):
    pcm = (np.arange(480 * 3 + 100) % 300).astype("<i2").tobytes()
    pieces = [pcm[:7], pcm[7:1001], pcm[1001:2500], pcm[2500:]]  # odd sizes, split samples

    async def body():
        for p in pieces:
            yield p

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/voice/stream"
        return httpx.Response(200, content=body())

    monkeypatch.setattr(hvs, "_HTTP", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.delenv("XTTS_URL", raising=False)
    hvs._STREAM_DOWN.clear()

    async def run():
        return [c async for c in hvs.HybridVoiceSynthesizer("alice").stream("Bonjour, je suis là.")]

    chunks = asyncio.run(run())
    assert [len(c._buffer) for c in chunks] == [480, 480, 480, 100]
    assert np.concatenate([c._buffer for c in chunks]).tobytes() == pcm


def test_a_failing_voice_server_is_skipped_then_the_whole_phrase_path_is_used(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(503)

    monkeypatch.setattr(hvs, "_HTTP", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.delenv("XTTS_URL", raising=False)
    hvs._STREAM_DOWN.clear()
    whole = [hvs.SpeechBuffer(np.zeros(480, dtype=np.int16), 24000)]

    async def fake_whole(self, text):
        return whole

    monkeypatch.setattr(hvs.HybridVoiceSynthesizer, "synthesize_stream", fake_whole)

    async def run():
        s = hvs.HybridVoiceSynthesizer("alice")
        first = [c async for c in s.stream("Hello there.")]
        second = [c async for c in s.stream("Again.")]
        return first, second

    first, second = asyncio.run(run())
    assert first == whole and second == whole
    assert len(calls) == 1, "the failed voice server isn't asked again for every phrase"
