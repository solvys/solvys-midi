# SolvysMIDI Progress

## 2026-06-25: Public Hardening Sprint

- Goal: harden SolvysMIDI as a public, forkable, compute-backed PWA without changing the core mobile product loop.
- App API hardening: added same-origin write checks, body-size caps, coarse per-IP rate limits, MIDI header validation, and stricter public song metadata.
- Storage hardening: shared song JSON no longer embeds MIDI or score base64; stored Blob URLs are the source of truth for shared downloads.
- Worker hardening: production worker configs now require bearer-token mode, audio jobs have active-job/request-size limits, and audio job records persist to `JOB_STORE_DIR`.
- PWA hardening: service worker bypasses `/api/*` so health checks, shared songs, and long-running job polling are never stale-cache responses.
- Supply-chain baseline: patched Next.js/Vercel Blob, added `postcss`/`undici` overrides, and reached `npm audit` zero vulnerabilities locally.
- Repo hygiene: added CI, CodeQL, Dependabot, issue templates, PR template, `SECURITY.md`, `CONTRIBUTING.md`, and `docs/production-hardening.md`.
- Verification so far: `npm run lint`, `npm run build`, and `npm audit --json` passed locally after the first hardening slice.

## 2026-06-21: YouTube-to-Playable-MIDI Product Loop

- Goal: paste a YouTube link in the PWA, transcribe audio with free/open-source tooling, arrange the result into a playable piano MIDI, store it in the shared library, and make it downloadable from the app.
- Baseline check: `/api/health` reported the audio worker online, but a real `/api/audio/youtube` request for the existing Reverie video failed before transcription with a YouTube `403` from `yt-dlp`.
- Architecture fix in progress: keep Vercel as the app/API boundary, keep heavy transcription in `audio-worker/`, and make the worker return arranged playable MIDI rather than raw transcription output.
- Worker changes: current yt-dlp release from GitHub, Deno runtime support, stronger YouTube extractor flags, conservative retries, and a deterministic two-hand piano arrangement pass after transcription.
- App changes: YouTube imports now show staged long-running progress, preserve engine/quantizer/arrangement metadata, and save the arranged result through the existing shared library path.

## 2026-06-24: Production YouTube-to-MIDI Loop Verified

- Replaced the fragile synchronous `/transcribe` request path with async worker jobs: `POST /jobs` starts a background transcription, `GET /jobs/:id` polls state/status/result, and the PWA uses `/api/audio/youtube/jobs` plus `/api/audio/youtube/jobs/[jobId]`.
- Kept Transkun available as a high-accuracy worker mode, but set production default to Basic Pitch primary because Transkun was highly variable on the deployed CPU. Transkun completed one direct optimized run in 154s, then hung past 11 minutes through the app path. Basic Pitch primary completed production E2E in 23s.
- Normalized downloaded YouTube audio to mono 44.1kHz before analysis and added a low-velocity timeline marker so the downloadable MIDI duration matches the probed source audio duration.
- Worker runtime is deployed on Fly with 4 shared CPUs, 4GB RAM, a warm minimum machine, Deno-enabled yt-dlp, and current yt-dlp from GitHub.
- Evidence:
  - Direct worker Basic Pitch job: `docs/evidence/latest-worker-job-summary.json` shows `ok: true`, engine `Basic Pitch`, 1379 arranged notes, and 176.384s source audio.
  - MIDI inspection: `docs/evidence/latest-midi-inspection.json` shows 176.3840909s MIDI duration, 1379 musical notes, and a one-note internal `Timeline` marker.
  - Local app API E2E: `docs/evidence/latest-app-api-e2e-summary.json` shows job completion, shared library save, and stored MIDI download.
  - Browser E2E: `docs/evidence/latest-browser-e2e-summary.json` shows mobile viewport New-tab import flow rendered a Reverie song and waveform with no console issues.
  - Production API E2E: `docs/evidence/latest-production-api-e2e-summary.json` shows `https://solvysmidi.vercel.app` job completion, shared save, and stored MIDI download.
  - Production browser smoke: `docs/evidence/latest-production-browser-smoke.json` shows `https://solvysmidi.vercel.app/` loading with no console issues.
- Deployed frontend production URL: `https://solvysmidi.vercel.app`.
- Caveat: the downloadable MIDI preserves the actual YouTube media returned by yt-dlp, which probes at about 176.384s. The user-provided 2:59 expectation is about 2.6s longer than the source audio available to the worker.
