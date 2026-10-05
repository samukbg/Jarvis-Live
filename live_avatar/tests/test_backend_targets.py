import textwrap
import types
from pathlib import Path

# gemini_client imports the whole streamer; load just _backend_targets from its source.
SRC = Path(__file__).resolve().parents[1] / "src/avaturn_live_streamer/conversation_engines/gemini_client.py"
source = SRC.read_text()
start = source.index("    def _backend_targets(self)")
end = source.index("    async def _fetch_installed_agents", start)
module = types.ModuleType("backend_targets_under_test")
module._JARVIS_API_KEY = "owner-key"
module._get_candidate_host_bases = lambda url: [u for u in [url, "http://127.0.0.1:4000"] if u]
exec(textwrap.dedent(source[start:end]), module.__dict__)


def engine(**config):
    return types.SimpleNamespace(_config=types.SimpleNamespace(**config))


def test_a_remote_backend_is_the_only_target_and_gets_its_own_key():
    bases, headers = module._backend_targets(engine(jarvis_backend_url="https://jarvis.example.com/", jarvis_backend_key="remote-key"))
    assert bases == ["https://jarvis.example.com"]
    assert headers == {"x-api-key": "remote-key"}


def test_without_a_key_the_servers_own_backend_and_key_are_used():
    bases, headers = module._backend_targets(engine(jarvis_backend_url=None, jarvis_backend_key=None))
    assert bases == ["http://127.0.0.1:4000"]
    assert headers == {"x-api-key": "owner-key"}
