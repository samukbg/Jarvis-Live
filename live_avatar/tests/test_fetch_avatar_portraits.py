import importlib.util
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "fetch_avatar_portraits", Path(__file__).resolve().parents[1] / "scripts/fetch_avatar_portraits.py"
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def test_adds_missing_portraits_and_keeps_existing(tmp_path):
    src, dest = tmp_path / "hf", tmp_path / "local"
    src.mkdir()
    dest.mkdir()
    (src / "maria.png").write_bytes(b"hf-maria")
    (src / "alice.png").write_bytes(b"hf-alice")
    (dest / "alice.png").write_bytes(b"ours")  # ours wins
    (dest / "custom.png").write_bytes(b"made here")  # kept

    assert mod.add_missing(src, dest) == ["maria.png"]
    assert (dest / "maria.png").read_bytes() == b"hf-maria"
    assert (dest / "alice.png").read_bytes() == b"ours"
    assert (dest / "custom.png").exists()
    assert mod.add_missing(src, dest) == []


def test_token_from_env_file(tmp_path):
    env = tmp_path / ".env"
    env.write_text('API_KEY=x\nHF_TOKEN="hf_abc"\n')
    assert mod.token_from_env_file(env) == "hf_abc"
    assert mod.token_from_env_file(tmp_path / "missing") is None
