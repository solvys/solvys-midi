import { NextRequest, NextResponse } from "next/server";
import { cleanText, numericEnv, rateLimit, readJsonBody, requireSameOrigin } from "@/lib/server/guards";
import { getYouTubeId } from "@/lib/youtube";
import {
  audioEngineLabel,
  audioWorkerHeaders,
  audioWorkerUrl,
  jsonError,
  transcriptionPayloadFromWorkerResult,
  workerErrorMessage,
  type AudioWorkerResponse,
  type ImportRequest,
} from "./shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LEGACY_AUDIO_REQUEST_MAX_BYTES = numericEnv("LEGACY_AUDIO_REQUEST_MAX_BYTES", 8 * 1024);

export async function POST(request: NextRequest) {
  if (process.env.ENABLE_LEGACY_AUDIO_ROUTE !== "1") {
    return jsonError("Use /api/audio/youtube/jobs for YouTube transcription.", 410, {
      asyncRoute: "/api/audio/youtube/jobs",
    });
  }

  const originRejection = requireSameOrigin(request);
  if (originRejection) {
    return originRejection;
  }

  const rateLimitRejection = rateLimit(request, {
    key: "audio-youtube:legacy",
    max: 2,
    windowMs: 60 * 60 * 1000,
  });
  if (rateLimitRejection) {
    return rateLimitRejection;
  }

  const parsed = await readJsonBody<ImportRequest | null>(request, LEGACY_AUDIO_REQUEST_MAX_BYTES);
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

  const requestBody = {
    youtubeUrl,
    title: cleanText(body?.title, 160),
    artist: cleanText(body?.artist, 160),
    year: cleanText(body?.year, 20),
    genre: cleanText(body?.genre, 80),
    subGenre: cleanText(body?.subGenre, 120),
  };

  try {
    const response = await fetch(`${workerUrl}/transcribe`, {
      method: "POST",
      headers: audioWorkerHeaders(),
      body: JSON.stringify(requestBody),
    });
    const result = (await response.json().catch(() => ({}))) as AudioWorkerResponse;

    if (!response.ok || !result.midiBase64) {
      return jsonError(
        workerErrorMessage(result.error || "The open-source audio worker could not transcribe this video."),
        response.status,
        {
          workerError: result.error,
          engine: result.engine || "Transkun",
          quantizer: result.quantizer || "grid",
        },
      );
    }

    return NextResponse.json(await transcriptionPayloadFromWorkerResult(result, requestBody));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Open-source audio import failed.", 502, {
      engine: audioEngineLabel(),
    });
  }
}
