import types
from pathlib import Path

# gemini_client imports the whole streamer; load just the delegation rules from its source.
SRC = Path(__file__).resolve().parents[1] / "src/avaturn_live_streamer/conversation_engines/gemini_client.py"
source = SRC.read_text()
start = source.index("# Delegation tool → the agent id")
end = source.index("\n_DEFAULT_LIVE_MODEL", start)
module = types.ModuleType("delegation_rules_under_test")
exec(source[start:end], module.__dict__)


def test_rules_list_only_the_installed_agents():
    rules = module._delegation_rules(["delegate_to_claude", "delegate_to_codex"])
    assert "sub-agents: Claude, Codex." in rules
    assert "- delegate_to_claude:" in rules and "- delegate_to_codex:" in rules
    assert "delegate_to_agy" not in rules and "delegate_to_hermes" not in rules
    assert "{AGENTS}" not in rules and "{TOOLS}" not in rules


def test_every_tool_maps_to_a_detected_agent_id():
    assert {v[0] for v in module._DELEGATION_AGENTS.values()} == {"gemini", "claude", "hermes", "codex"}
