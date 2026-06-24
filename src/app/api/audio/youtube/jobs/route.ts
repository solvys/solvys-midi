import { NextRequest, NextResponse } from "next/server";
import { getYouTubeId } from "@/lib/youtube";
import {
  audioWorkerHeaders,
  audioWorkerUrl,
  clean,
  jsonError,
  workerErrorMessage,
  type AudioWorkerJobResponse,
  type ImportRequest,
} from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ImportRequest | null;
  const youtubeUrl = clean(body?.youtubeUrl);

  if (!youtubeUrl || !getYouTubeId(youtubeUrl)) {
    return jsonError("Paste a valid YouTube link before importing audio.", 400);
  }

  const workerUrl = audioWorkerUrl();
  if (!workerUrl) {
    return jsonError(
      "Open-source audio transcription is not configured. Deploy audio-worker/ and set AUDIO_TRANSCRIPTION_WORKER_URL.",
      503,
      {
        engine: "Transkun",
        quantizer: "Basic Pitch-assisted grid",
      },
    );
  }

  const requestBody: ImportRequest = {
    youtubeUrl,
    title: clean(body?.title),
    artist: clean(body?.artist),
    year: clean(body?.year),
    genre: clean(body?.genre),
    subGenre: clean(body?.subGenre),
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
          engine: "Transkun",
          quantizer: "grid",
        },
      );
    }

    return NextResponse.json(payload, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Open-source audio job start failed.", 502, {
      engine: "Transkun",
    });
  }
}
