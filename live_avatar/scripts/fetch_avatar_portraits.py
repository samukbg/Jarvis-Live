# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: LicenseRef-AVTR-1-Community

"""Add the AVTR-1 avatar portraits and backgrounds from Hugging Face that this renderer
doesn't have yet, keeping the ones it has (avatars created on this server).

The artifact manager downloads ``avatars_artifacts/reference_frames`` only when the folder
is missing, so a renderer whose folder already existed (with one custom avatar) never got
Maria & co. The renderer loads new portraits on its next /avatars call — no restart.

The HF repo is gated: it needs a token whose account accepted the AVTR-1 terms — HF_TOKEN
in the environment, in this project's .env (boot copies the server's .env here), or a
saved `hf auth login`.

Usage (run by live_avatar/sync_to_wsl.bat on every boot, and by the setup):
    pixi run python scripts/fetch_avatar_portraits.py
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

SUBDIRS = ("avatars_artifacts/reference_frames", "avatars_artifacts/backgrounds")


def add_missing(src_dir: Path, dest_dir: Path) -> list[str]:
    """Copy files from src_dir that dest_dir lacks; never overwrite or delete."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    added = []
    for f in sorted(src_dir.glob("*")):
        if f.is_file() and not (dest_dir / f.name).exists():
            shutil.copy2(f, dest_dir / f.name)
            added.append(f.name)
    return added


def _config() -> tuple[str, str]:
    """HF repo and revision from artifact_configs/v1.py, read without importing the
    renderer package (it pulls in OpenCV, TensorRT…)."""
    ns: dict = {}
    src = (Path(__file__).resolve().parents[1] / "src/avtr1_renderer/artifact_configs/v1.py").read_text()
    for line in src.splitlines():
        if line.startswith(("HF_REPO_ID", "HF_REVISION")):
            exec(line, ns)
    return ns["HF_REPO_ID"], ns["HF_REVISION"]


def storage_root(revision: str) -> Path:
    """Same rule as avtr1_artifact_manager.get_storage_root."""
    base = os.environ.get("AVTR1_LOCAL_STORAGE")
    return Path(base) / revision if base else Path(__file__).resolve().parents[1] / "artifacts" / revision


def token_from_env_file(env_file: Path) -> str | None:
    """HF_TOKEN=... from a .env file, if there."""
    try:
        for line in env_file.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "HF_TOKEN" and value.strip():
                return value.strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def main() -> None:
    from huggingface_hub import snapshot_download

    if not os.environ.get("HF_TOKEN"):
        token = token_from_env_file(Path(__file__).resolve().parents[1] / ".env")
        if token:
            os.environ["HF_TOKEN"] = token

    repo_id, revision = _config()
    root = storage_root(revision)
    try:
        snapshot = Path(snapshot_download(
            repo_id=repo_id,
            revision=revision,
            allow_patterns=[f"{d}/*" for d in SUBDIRS],
            repo_type="model",
        ))
    except Exception as exc:  # gated repo without a token, offline…
        print(f"Avatar portraits not updated: {exc}".splitlines()[0])
        print("The AVTR-1 repo is gated: put HF_TOKEN=hf_... (an account that accepted its terms) in .env.")
        return
    for sub in SUBDIRS:
        added = add_missing(snapshot / sub, root / sub)
        print(f"{sub}: {'added ' + ', '.join(added) if added else 'up to date'}")


if __name__ == "__main__":
    main()
