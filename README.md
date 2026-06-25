# SolvysMIDI

Mobile-first Next.js PWA for turning piano score exports into MIDI files.

## Open Source

This repository is public and MIT licensed. Anyone can clone, download, fork, modify, and redistribute it under the terms in [`LICENSE`](./LICENSE).

Please preserve the SolvysMIDI credits when reusing or forking the project. See [`CREDITS.md`](./CREDITS.md) for direct project credits and upstream open-source acknowledgments.

Security, contribution, and production hardening notes live in [`SECURITY.md`](./SECURITY.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md), and [`docs/production-hardening.md`](./docs/production-hardening.md).

## What Works Locally

- MusicXML, XML, and compressed MXL import
- Full PDF optical music recognition through the free Audiveris worker in `omr-worker/`
- Optional open-source YouTube audio import through the Basic Pitch + Transkun worker
- Playable two-hand piano arrangement cleanup for YouTube audio imports
- MIDI generation in the browser
- In-app sheet preview for imports that include MusicXML
- Transcription history in local storage for successful sheet-music imports only
- Artist, year made, genre, and classical sub-genre sorting
- Waveform preview tied to generated note playback
- YouTube thumbnail and soundbite preview by URL
- Manual MIDI download everywhere
- Default import/export folder label set to `~/iCloud Drive/MIDI Board`
- Automatic folder export where the browser supports the File System Access API

PDF optical music recognition is intentionally free: deploy the included `omr-worker/` service and set `OMR_WORKER_URL` on Vercel. The worker runs Audiveris, which converts printed score PDFs to MusicXML/MXL; the PWA then converts that MusicXML into MIDI. Browser PWAs cannot silently write to arbitrary local paths; users must grant `~/iCloud Drive/MIDI Board` once in the folder picker, then automatic exports can reuse the saved directory handle when permission remains granted.

## Free PDF OMR Worker

The Vercel app should not run Audiveris directly. Audiveris is a Java OMR engine and can take long enough that it belongs in a dedicated worker. The worker is still free/open-source; it just needs compute.

```bash
cd omr-worker
docker buildx build --platform linux/amd64 --load -t solvys-midi-omr .
docker run --rm --platform linux/amd64 -p 8080:8080 solvys-midi-omr
```

Then point the PWA at it:

```bash
OMR_WORKER_URL=https://your-worker-host
OMR_WORKER_TOKEN=shared-secret
```

Worker contract:

- `GET /health` returns `{ "ok": true, "engine": "Audiveris" }`.
- `POST /transcribe` accepts multipart field `file` with a `.pdf`.
- It returns either `{ "musicXml": "..." }` or `{ "mxlBase64": "..." }`.

On an amd64 Linux host, plain `docker build -t solvys-midi-omr .` is fine. The `buildx --platform linux/amd64` form is included because the Audiveris package used by this worker is currently x86_64. This path uses free/open-source OMR instead of a paid transcription API.

Audiveris handles printed common Western music notation. Handwritten scores and messy scans can still need correction; the app will only be as accurate as the OMR result.

## Production Deployment

- PWA: `https://solvysmidi.vercel.app`
- OMR worker: `https://solvys-midi-omr.fly.dev`
- Audio worker: `https://solvys-midi-audio.fly.dev`
- Vercel production env: `OMR_WORKER_URL=https://solvys-midi-omr.fly.dev`
- Vercel production env: `AUDIO_TRANSCRIPTION_WORKER_URL=https://solvys-midi-audio.fly.dev`

The worker is deployed from `omr-worker/fly.toml` with one auto-suspending Fly machine and no minimum machines running.

Production workers are configured to fail closed with `REQUIRE_WORKER_TOKEN=1`. Set matching worker secrets on Fly and Vercel before deploying token-required worker configs.

## Open-Source YouTube Audio Import

The New tab accepts either a score file or a YouTube link. YouTube-only submissions start an async job through `/api/audio/youtube/jobs`, poll `/api/audio/youtube/jobs/[jobId]`, and save the finished MIDI through `/api/songs`.

The audio worker is free/open-source:

- `yt-dlp` fetches the source audio from the user-provided YouTube link.
- `Basic Pitch` is the production default audio-to-MIDI engine because it gives usable latency on the deployed worker.
- `Transkun` remains available as a high-accuracy mode by setting `AUDIO_ENGINE_MODE=transkun`.
- A MIDI grid quantizer snaps the returned transcription to cleaner note starts and durations.
- A deterministic arranger thins dense note clusters, splits left/right hands, and exports a playable two-track piano MIDI.
- A low-velocity internal `Timeline` marker preserves the source audio duration in the downloadable MIDI while the app ignores that marker for note counts and previews.

YouTube changes frequently. The worker image installs a current `yt-dlp` release from GitHub and includes Deno for modern YouTube extraction. If a specific video still returns `403`, set `YTDLP_COOKIES_FILE` in the worker environment with cookies for videos that require browser/account context.

Basic Pitch is not a standalone quantizer; it is another audio-to-MIDI transcription model. The worker applies its own deterministic MIDI quantization pass after whichever engine is selected.

```bash
cd audio-worker
docker build -t solvys-midi-audio .
docker run --rm -p 8081:8080 solvys-midi-audio
```

Then point the PWA at it:

```bash
AUDIO_TRANSCRIPTION_WORKER_URL=https://your-audio-worker-host
AUDIO_TRANSCRIPTION_WORKER_TOKEN=shared-secret
AUDIO_ENGINE_MODE=basic-pitch
BASIC_PITCH_MODE=fallback
YTDLP_COOKIES_FILE=optional-worker-local-cookie-file
```

The app stores generated MIDI and uploaded score files. It should not store downloaded YouTube source audio. Users are responsible for having the rights needed to transcribe, arrange, store, and download generated output.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Vercel Environment

No environment variables are required for local MusicXML import. PDF import requires `OMR_WORKER_URL`. YouTube audio import requires `AUDIO_TRANSCRIPTION_WORKER_URL`. Optional variables are listed in `.env.example`.

## Checks

```bash
npm audit --audit-level=high
npm run lint
npm run build
python3 -m py_compile audio-worker/server.py
cd omr-worker && npm ci && node --check server.mjs
```

## License

MIT. See [`LICENSE`](./LICENSE).
