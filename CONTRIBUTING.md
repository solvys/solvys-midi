# Contributing to SolvysMIDI

Thanks for helping make SolvysMIDI better for piano players.

## Local Setup

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

MusicXML/XML/MXL conversion works without external services. PDF and YouTube transcription need the worker services listed in `.env.example`.

## Before Opening a PR

```bash
npm audit --audit-level=high
npm run lint
npm run build
python -m py_compile audio-worker/server.py
cd omr-worker && npm ci && node --check server.mjs
```

For user-facing changes, verify the actual PWA flow in a mobile-sized browser viewport.

## Product Guardrails

- Keep the first screen as the usable app, not a marketing page.
- Do not make PDF upload required for the YouTube-only flow.
- Do not store downloaded YouTube source audio.
- Keep generated MIDI downloadable from mobile browsers.
- Keep the shared library usable without requiring Google auth.
- Preserve the SolvysMIDI credits in forks and redistributed builds.

## Worker Guardrails

- Heavy transcription belongs in `audio-worker/` and `omr-worker/`, not inside Vercel route handlers.
- Production workers should run with `REQUIRE_WORKER_TOKEN=1`.
- Keep request and upload size limits conservative.
- Prefer open-source transcription and OMR tools unless the product explicitly adds a paid connector.
