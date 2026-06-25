# SolvysMIDI Progress

## 2026-06-25: Public Hardening Sprint

- Goal: harden SolvysMIDI as a public, forkable, compute-backed PWA without changing the core mobile product loop.
- App API hardening: added same-origin write checks, body-size caps, coarse per-IP rate limits, MIDI header validation, and stricter public song metadata.
- Storage hardening: shared song JSON no longer embeds MIDI or score base64; stored Blob URLs are the source of truth for shared downloads.
- Worker hardening: production worker configs now require bearer-token mode, audio jobs have active-job/request-size limits, and audio job records persist to `JOB_STORE_DIR`.
- PWA hardening: service worker bypasses `/api/*` so health checks, shared songs, and long-running job polling are never stale-cache responses.
- Supply-chain baseline: patched Next.js/Vercel Blob, added `postcss`/`undici` overrides, and reached `npm audit` zero vulnerabilities locally.
- Repo hygiene: added CI, CodeQL, Dependabot, issue templates, PR template, `SECURITY.md`, `CONTRIBUTING.md`, and `docs/production-hardening.md`.
- Verification so far: `npm audit --audit-level=high`, `npm run lint`, `npm run build`, `python3 -m py_compile audio-worker/server.py`, and `cd omr-worker && npm ci && node --check server.mjs` passed locally.
- Local API probes verified health, legacy sync route disablement, invalid MIDI rejection, cross-origin write rejection, and app-side invalid YouTube URL rejection.
- Local mobile browser smoke wrote `docs/evidence/latest-local-hardening-smoke.png`; the New tab accepted a YouTube URL with no file selected and no browser console errors.
- Deployed audio worker, OMR worker, and Vercel production after setting matching worker tokens on Fly and Vercel.
- Production hardening probes verified app health, legacy sync route disablement, invalid YouTube URL rejection before worker dispatch, invalid MIDI rejection, cross-origin write rejection, and direct worker `401` responses without bearer tokens.
- Production E2E wrote `docs/evidence/latest-production-hardening-e2e-summary.json`: YouTube-only import completed in 71s, saved a shared song, returned no public `midiBase64`, and downloaded a 10368-byte MIDI with `MThd` header.
- Production mobile browser smoke wrote `docs/evidence/latest-production-hardening-browser-smoke.png`; the New tab accepted a YouTube URL without requiring a file and produced no console errors.
- Vercel Firewall live rules: `SolvysMIDI YouTube job starts` at 6 POSTs/hour/IP, `SolvysMIDI PDF transcriptions` at 8 POSTs/hour/IP, and `SolvysMIDI shared song writes` at 24 POSTs/hour/IP.
- GitHub repo settings verified/enabled: public forkable repo, MIT license detected, secret scanning enabled, push protection enabled, Dependabot security updates enabled, `main` branch protection requiring CI and CodeQL checks.
- Dependabot surfaced PyTorch advisories from the optional Transkun stack; the default public audio worker now ships Basic Pitch only and leaves Transkun as a deliberate self-hosted variant until the PyTorch advisory surface is clean.
- Final dependency cleanup redeployed `solvys-midi-audio` without PyTorch/Transkun and redeployed Vercel production, then explicitly aliased the fresh deployment to `https://solvysmidi.vercel.app`.
- Fresh production E2E after the cleanup wrote `docs/evidence/latest-production-hardening-e2e-summary.json`: YouTube-only import completed in 71s, saved a shared song, exposed no public `midiBase64`, and downloaded a 10368-byte MIDI with `MThd` header.
- Fresh production browser smoke wrote `docs/evidence/latest-production-hardening-browser-smoke.json` and `docs/evidence/latest-production-hardening-browser-smoke.png`: mobile New tab accepted a YouTube link with no file selected, the submit button was visible, the body remained non-scrolling, and there were no console errors.
- GitHub Dependabot API returned no open alerts after removing the default PyTorch dependency stack.
- Dedicated review found 4 open CodeQL worker findings; the follow-up branch makes audio job IDs regex-checked before persistence, resolves job files under the configured store directory, writes temp job files inside that directory before atomic replace, and runs worker subprocesses through a fixed executable allow-list with `shell=False`.
- Dedicated review also aligned the worker's source default with the safe public image: Basic Pitch is now the no-env default, while Transkun remains an explicit self-hosted mode.

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
