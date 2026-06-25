# Production Hardening

This is the hardening checklist for the public SolvysMIDI deployment.

## Implemented in Source

- Same-origin POST enforcement for shared library writes, YouTube job starts, legacy YouTube transcription, and PDF transcription.
- Coarse per-IP rate limits for CPU/storage-heavy app routes.
- Request body size caps for JSON transcription requests, shared song writes, and PDF uploads.
- MIDI base64 validation before Blob writes.
- Public song metadata no longer embeds MIDI or score base64; stored file URLs are used for download.
- Service worker bypasses `/api/*` so song lists, health checks, and job polling stay live.
- Audio and OMR workers can fail closed with `REQUIRE_WORKER_TOKEN=1`.
- Audio worker has max active-job limits, max request size, and persisted job records.
- CI, CodeQL, Dependabot, issue templates, PR template, security policy, and contribution guide are present.

## Required Platform Settings

### Vercel

Set these production variables:

```text
OMR_WORKER_URL=https://solvys-midi-omr.fly.dev
OMR_WORKER_TOKEN=<shared secret>
AUDIO_TRANSCRIPTION_WORKER_URL=https://solvys-midi-audio.fly.dev
AUDIO_TRANSCRIPTION_WORKER_TOKEN=<shared secret>
BLOB_READ_WRITE_TOKEN=<vercel blob token>
AUDIO_ENGINE_MODE=basic-pitch
BASIC_PITCH_MODE=fallback
```

Live Vercel Firewall/WAF rules:

- `SolvysMIDI YouTube job starts`: `POST /api/audio/youtube/jobs`, 6 requests/hour/IP.
- `SolvysMIDI PDF transcriptions`: `POST /api/transcribe`, 8 requests/hour/IP.
- `SolvysMIDI shared song writes`: `POST /api/songs`, 24 requests/hour/IP.

The in-app rate limiter is a defense-in-depth fallback. Platform WAF should be the primary public quota.

### Fly.io Workers

Set these secrets:

```text
fly secrets set AUDIO_TRANSCRIPTION_WORKER_TOKEN=<shared secret> -a solvys-midi-audio
fly secrets set OMR_WORKER_TOKEN=<shared secret> -a solvys-midi-omr
```

Both worker configs set `REQUIRE_WORKER_TOKEN=1`. Public health checks remain unauthenticated, but compute endpoints require bearer tokens.

For stronger audio job durability, attach a Fly volume and keep `JOB_STORE_DIR=/data/jobs`.

### GitHub

Enabled:

- secret scanning and push protection,
- Dependabot alerts and security updates,
- Code scanning alerts,
- branch protection on `main` requiring CI and CodeQL before merge.

## Legal and Product Safety

- Store generated MIDI and user-uploaded score files only.
- Do not store downloaded YouTube audio.
- Keep YouTube preview as a YouTube embed/link, not a copied audio file.
- Tell users they must have rights to transcribe, arrange, store, and download generated output.
- Honor takedown/delete requests for stored MIDI or scores.

## Verification Loop

Before declaring a deployment good:

1. `npm audit --audit-level=high`
2. `npm run lint`
3. `npm run build`
4. worker syntax checks
5. production `/api/health`
6. mobile browser smoke
7. YouTube-only import E2E
8. stored MIDI download returns a MIDI file
