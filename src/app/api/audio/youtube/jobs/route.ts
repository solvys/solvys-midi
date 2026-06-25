import { NextRequest, NextResponse } from "next/server";
import { cleanText, numericEnv, rateLimit, readJsonBody, requireSameOrigin } from "@/lib/server/guards";
import { getYouTubeId } from "@/lib/youtube";
import {
  audioEngineLabel,
  audioWorkerHeaders,
  audioWorkerUrl,
  jsonError,
  workerErrorMessage,
  type AudioWorkerJobResponse,
  type ImportRequest,
} from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const AUDIO_JOB_STARTS_PER_HOUR = numericEnv("AUDIO_JOB_STARTS_PER_HOUR", 6);
const AUDIO_JOB_REQUEST_MAX_BYTES = numericEnv("AUDIO_JOB_REQUEST_MAX_BYTES", 8 * 1024);

export async function POST(request: NextRequest) {
  const originRejection = requireSameOrigin(request);
  if (originRejection) {
    return originRejection;
  }

  const rateLimitRejection = rateLimit(request, {
    key: "audio-jobs:start",
    max: AUDIO_JOB_STARTS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (rateLimitRejection) {
    return rateLimitRejection;
  }

  const parsed = await readJsonBody<ImportRequest | null>(request, AUDIO_JOB_REQUEST_MAX_BYTES);
  if (parsed.error) {
    return parsed.error;
  }

  const body = parsed.body;
  const youtubeUrl = cleanText(body?.youtubeUrl, 500);

  if (!youtubeUrl || !getYouTubeId(youtubeUrl)) {
    return jsonError("Paste a valid YouTube link before importing audio.", 400);
  }

  const workerUrl = audioWorkerUrl();
  if (!workerUrl) {
    return jsonError(
      "Open-source audio transcription is not configured. Deploy audio-worker/ and set AUDIO_TRANSCRIPTION_WORKER_URL.",
      503,
      {
        engine: audioEngineLabel(),
        quantizer: "Basic Pitch-assisted grid",
      },
    );
  }

  const requestBody: ImportRequest = {
    youtubeUrl,
    title: cleanText(body?.title, 160),
    artist: cleanText(body?.artist, 160),
    year: cleanText(body?.year, 20),
    genre: cleanText(body?.genre, 80),
    subGenre: cleanText(body?.subGenre, 120),
  };

  try {
    const response = await fetch(`${workerUrl}/jobs`, {
      method: "POST",
      headers: audioWorkerHeaders(),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(25_000),
    });
    const payload = (await response.json().catch(() => ({}))) as AudioWorkerJobResponse;

    if (!response.ok || !payload.jobId) {
      return jsonError(
        workerErrorMessage(payload.error || "The open-source audio worker could not start this transcription job."),
        response.status,
        {
          workerError: payload.error,
          engine: audioEngineLabel(),
          quantizer: "grid",
        },
      );
    }

    return NextResponse.json(payload, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Open-source audio job start failed.", 502, {
      engine: audioEngineLabel(),
    });
  }
}
