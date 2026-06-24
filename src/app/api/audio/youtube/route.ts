import { NextRequest, NextResponse } from "next/server";
import { getYouTubeId } from "@/lib/youtube";
import {
  audioWorkerHeaders,
  audioWorkerUrl,
  clean,
  jsonError,
  transcriptionPayloadFromWorkerResult,
  workerErrorMessage,
  type AudioWorkerResponse,
  type ImportRequest,
} from "./shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  const requestBody = {
    youtubeUrl,
    title: clean(body?.title),
    artist: clean(body?.artist),
    year: clean(body?.year),
    genre: clean(body?.genre),
    subGenre: clean(body?.subGenre),
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
      engine: "Transkun",
    });
  }
}
