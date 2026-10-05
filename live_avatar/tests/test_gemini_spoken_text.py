import importlib.util
import sys
import types
from pathlib import Path

# gemini_client imports the whole streamer; load just `spoken_text` from its source.
SRC = Path(__file__).resolve().parents[1] / "src/avaturn_live_streamer/conversation_engines/gemini_client.py"
source = SRC.read_text()
start = source.index("def spoken_text(")
end = source.index("\n@attrs.define", start)
module = types.ModuleType("spoken_text_under_test")
exec("from typing import Any\n" + source[start:end], module.__dict__)
spoken_text = module.spoken_text


def test_prefers_the_audio_transcription():
    sc = {"outputTranscription": {"text": "Oui, je t'entends."}, "modelTurn": {"parts": [{"text": "x", "thought": True}]}}
    assert spoken_text(sc) == "Oui, je t'entends."


def test_never_speaks_thoughts():
    sc = {"modelTurn": {"parts": [
        {"text": "**Confirming Immediate Response** I've registered a repetition...", "thought": True},
        {"text": "Oui, je t'entends."},
    ]}}
    assert spoken_text(sc) == "Oui, je t'entends."


def test_a_thought_only_message_says_nothing():
    assert spoken_text({"modelTurn": {"parts": [{"text": "Planning the answer", "thought": True}]}}) == ""


def test_audio_parts_and_empty_messages():
    assert spoken_text({"modelTurn": {"parts": [{"inlineData": {"data": "AAAA"}}]}}) == ""
    assert spoken_text({}) == ""
