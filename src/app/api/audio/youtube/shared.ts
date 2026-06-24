import { NextResponse } from "next/server";
import { midiBytesToTranscriptionPayload } from "@/lib/midi-summary";
import { getYouTubeId } from "@/lib/youtube";

export type ImportRequest = {
  youtubeUrl?: string;
  title?: string;
  artist?: string;
  year?: string;
  genre?: string;
  subGenre?: string;
};

export type AudioWorkerResponse = {
  midiBase64?: string;
  engine?: string;
  quantizer?: string;
  arrangement?: string;
  arrangementStats?: {
    inputNotes?: number;
    arrangedNotes?: number;
    leftHandNotes?: number;
    rightHandNotes?: number;
    maxNotesPerSlice?: number;
  };
  audioDurationSeconds?: number;
  warnings?: string[];
  error?: string;
};

export type AudioWorkerJobResponse = {
  jobId?: string;
  state?: "queued" | "running" | "completed" | "failed";
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  request?: ImportRequest;
  result?: AudioWorkerResponse;
  error?: string;
};

export function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function jsonError(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

export function workerErrorMessage(error: string) {
  if (/HTTP Error 403|SABR|unable to download video data/i.test(error)) {
    return "YouTube blocked the audio fetch before transcription. The audio worker needs the current yt-dlp/Deno build and may need cookies for this video.";
  }

  return error;
}

export function audioWorkerUrl() {
  return process.env.AUDIO_TRANSCRIPTION_WORKER_URL?.trim().replace(/\/$/, "") ?? "";
}

export function audioWorkerHeaders() {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  const token = process.env.AUDIO_TRANSCRIPTION_WORKER_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return headers;
}

export async function youtubeMetadata(youtubeUrl: string) {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeUrl)}`,
      { cache: "no-store", signal: AbortSignal.timeout(3500) },
    );
    if (!response.ok) {
      return {};
    }

    const payload = (await response.json()) as { title?: string; author_name?: string };
    return {
      title: clean(payload.title),
      artist: clean(payload.author_name),
    };
  } catch {
    return {};
  }
}

export async function transcriptionPayloadFromWorkerResult(
  result: AudioWorkerResponse,
  request: ImportRequest,
) {
  const youtubeUrl = clean(request.youtubeUrl);
  const metadata = await youtubeMetadata(youtubeUrl);
  const title = clean(request.title) || metadata.title || `YouTube ${getYouTubeId(youtubeUrl)}`;

  const payload = midiBytesToTranscriptionPayload(Buffer.from(result.midiBase64 || "", "base64"), {
    title,
    artist: clean(request.artist) || metadata.artist || "YouTube",
    year: clean(request.year),
    genre: clean(request.genre) || "Classical",
    subGenre: clean(request.subGenre) || "Piano Solo",
  });

  return {
    ...payload,
    engine: result.engine || "Transkun",
    quantizer: result.quantizer || "grid",
    arrangement: result.arrangement || "Playable two-hand piano",
    arrangementStats: result.arrangementStats,
    warnings: result.warnings ?? [],
  };
}
