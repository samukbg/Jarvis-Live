# Extra avatar portraits

AVTR-1's own avatars (Maria, Elena, Marcus… — 18 portraits) come from Hugging Face:
`scripts/fetch_avatar_portraits.py` adds the ones a renderer lacks on every boot. The repo
is gated, so the server's `.env` needs `HF_TOKEN=hf_...` from an account that accepted the
AVTR-1 terms (huggingface.co/avaturn-live/avtr-1).

Portraits that aren't on Hugging Face (your own) go here. Every Jarvis server gets these: `live_avatar/sync_to_wsl.bat` (run by boot.bat and the
backend's sync-repo action) copies `*.png` here into the renderer's
`artifacts/main/avatars_artifacts/reference_frames/`, where the renderer loads each portrait
as an avatar (`maria.png` → avatar `maria`). Avatars created on one server stay there unless
their portrait is added here.

To share avatars created on one server, copy their portraits here (e.g. from another machine):

    copy \\wsl.localhost\Ubuntu\root\avtr-1\artifacts\main\avatars_artifacts\reference_frames\*.png live_avatar\avatars\
    git add live_avatar\avatars && git commit -m "avatars: built-in portraits" && git push
