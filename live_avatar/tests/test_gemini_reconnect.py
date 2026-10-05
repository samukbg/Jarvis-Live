import types
from pathlib import Path

import websockets
from websockets.frames import Close

# gemini_client imports the whole streamer; load just the reconnect rules from its source.
SRC = Path(__file__).resolve().parents[1] / "src/avaturn_live_streamer/conversation_engines/gemini_client.py"
source = SRC.read_text()
start = source.index("_TRANSIENT_CLOSE_CODES = ")
end = source.index("\n_DEFAULT_LIVE_MODEL", start)
module = types.ModuleType("gemini_reconnect_under_test")
module.websockets = websockets
exec(source[start:end], module.__dict__)


def closed(code):
    return websockets.exceptions.ConnectionClosedError(Close(code, "x") if code else None, None)


def test_gemini_internal_errors_and_drops_reconnect():
    assert module.reconnectable(ExceptionGroup("g", [closed(1011)]))
    assert module.reconnectable(ExceptionGroup("g", [closed(None)]))  # no close frame: network drop
    assert module.reconnectable(ExceptionGroup("g", [module._SessionDropped("closed 1000")]))
    assert module.reconnectable(ExceptionGroup("g", [ExceptionGroup("inner", [closed(1011)])]))


def test_real_bugs_and_policy_closes_do_not_reconnect():
    assert not module.reconnectable(ExceptionGroup("g", [closed(1007)]))  # invalid payload: our bug
    assert not module.reconnectable(ExceptionGroup("g", [closed(1008)]))  # policy (bad key, quota)
    assert not module.reconnectable(ExceptionGroup("g", [closed(1011), ValueError("bug")]))
    assert not module.reconnectable(ExceptionGroup("g", [ValueError("bug")]))
