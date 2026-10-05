# Contributing to Jarvis Live

Thanks for helping build an open, self-hosted Jarvis!

## Getting set up

```bash
cp .env.example .env        # add API_KEY and GEMINI_API_KEY
npm install && (cd backend && npm install)
./boot.sh
```

## Before you open a pull request

- `npm run build`: the web client type-checks and builds
- `npm test` and `cd backend && npm test`: client and server tests pass
- Avatar engine changes: `cd live_avatar && pixi run pytest tests`
- Never commit `.env`, API keys, personal avatars, voice recordings or `memory.json`

## Guidelines

- Keep pull requests focused: one feature or fix each.
- Match the surrounding code style.
- New cards, agents and tools are very welcome: open an issue first for big changes so we can agree on the design.
- Changes under `live_avatar/` stay under that directory's own licenses (see `live_avatar/LICENSE.md`); everything else is MIT.

## Reporting bugs

Open an issue with your OS, Node.js version, GPU (if the avatar is involved), what you expected and what happened, plus the relevant lines from `backend.log`.
