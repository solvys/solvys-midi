# Security Policy

## Supported Version

SolvysMIDI is early-stage open source software. Security fixes target the `main` branch.

## Reporting Vulnerabilities

Please do not open a public issue for secrets, bypasses, arbitrary file access, command execution, or abuse paths against the public transcription workers.

Report privately to the Solvys maintainers through the repository security advisory flow when available, or by contacting the repository owner directly. Include:

- affected route or worker endpoint,
- exact reproduction steps,
- whether the issue requires a valid user-supplied file or YouTube URL,
- expected impact,
- logs or screenshots with secrets removed.

## Production Security Expectations

Production deployments should:

- require `AUDIO_TRANSCRIPTION_WORKER_TOKEN` and `OMR_WORKER_TOKEN` on the workers and the Vercel app,
- keep `REQUIRE_WORKER_TOKEN=1` on both workers,
- rate-limit `/api/audio/youtube/jobs`, `/api/transcribe`, and `/api/songs`,
- keep Vercel Blob tokens server-side only,
- store generated MIDI and uploaded scores, not downloaded YouTube source audio,
- keep GitHub secret scanning, Dependabot, and CodeQL enabled.

## Content and Copyright

SolvysMIDI processes user-provided files and user-provided YouTube links. Users are responsible for having the rights needed to transcribe, arrange, store, and download generated MIDI files. The application should not store source YouTube audio.
