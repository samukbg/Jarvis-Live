import subprocess

import pytest

from avaturn_live_streamer.speech import hybrid_voice_synthesizer as hvs


@pytest.fixture(autouse=True)
def _clear_discovery_cache():
    hvs._WSL_DISCOVERY_CACHE = None
    yield
    hvs._WSL_DISCOVERY_CACHE = None


def test_env_renderer_url_skips_wsl_discovery(monkeypatch):
    monkeypatch.setattr(hvs.sys, "platform", "win32")
    monkeypatch.setenv("RENDERER_URL", "http://172.30.78.1:8000/")
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a))
    assert hvs._get_candidate_renderer_urls("http://172.30.78.1:8000") == ["http://172.30.78.1:8000"]
    assert calls == [], "wsl.exe must not be spawned when RENDERER_URL is known"


def test_wsl_discovery_runs_once_and_is_cached(monkeypatch):
    monkeypatch.setattr(hvs.sys, "platform", "win32")
    monkeypatch.delenv("RENDERER_URL", raising=False)
    calls = []

    class _Res:
        stdout = "172.17.0.1 172.30.78.5\n"

    def _fake_run(*args, **kwargs):
        calls.append(args)
        return _Res()

    monkeypatch.setattr(subprocess, "run", _fake_run)
    first = hvs._get_candidate_renderer_urls(None)
    second = hvs._get_candidate_renderer_urls(None)
    assert first == second == ["http://172.30.78.5:8000"]
    assert len(calls) == 1


def test_voice_server_comes_from_xtts_url_with_the_api_key(monkeypatch):
    monkeypatch.delenv("XTTS_URL", raising=False)
    assert hvs._voice_server() is None
    monkeypatch.setenv("XTTS_URL", "https://voice-gpu.example/")
    monkeypatch.setenv("API_KEY", "secret")
    monkeypatch.delenv("XTTS_API_KEY", raising=False)
    assert hvs._voice_server() == ("https://voice-gpu.example", {"x-api-key": "secret"})
    monkeypatch.setenv("XTTS_API_KEY", "other")
    assert hvs._voice_server()[1] == {"x-api-key": "other"}


def test_local_voice_server_is_the_last_resort_before_edge(monkeypatch):
    monkeypatch.delenv("VOICE_SERVER_PORT", raising=False)
    assert hvs._local_voice_server() == "http://127.0.0.1:8010"
    monkeypatch.setenv("VOICE_SERVER_PORT", "9010")
    assert hvs._local_voice_server() == "http://127.0.0.1:9010"
