import { NextRequest, NextResponse } from "next/server";
import { numericEnv, rateLimit } from "@/lib/server/guards";
import {
  audioEngineLabel,
  audioWorkerHeaders,
  audioWorkerUrl,
  jsonError,
  transcriptionPayloadFromWorkerResult,
  workerErrorMessage,
  type AudioWorkerJobResponse,
} from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AUDIO_JOB_POLLS_PER_WINDOW = numericEnv("AUDIO_JOB_POLLS_PER_WINDOW", 180);
const AUDIO_JOB_POLL_WINDOW_MS = numericEnv("AUDIO_JOB_POLL_WINDOW_MS", 20 * 60 * 1000);
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;

type RouteContext = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const rateLimitRejection = rateLimit(_request, {
    key: "audio-jobs:poll",
    max: AUDIO_JOB_POLLS_PER_WINDOW,
    windowMs: AUDIO_JOB_POLL_WINDOW_MS,
  });
  if (rateLimitRejection) {
    return rateLimitRejection;
  }

  const { jobId } = await context.params;
  const workerUrl = audioWorkerUrl();

  if (!JOB_ID_RE.test(jobId)) {
    return jsonError("Audio transcription job ID is invalid.", 400);
  }

  if (!workerUrl) {
    return jsonError("Open-source audio transcription is not configured.", 503, {
      engine: audioEngineLabel(),
      quantizer: "Basic Pitch-assisted grid",
    });
  }

  try {
    const response = await fetch(`${workerUrl}/jobs/${encodeURIComponent(jobId)}`, {
      headers: audioWorkerHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    const job = (await response.json().catch(() => ({}))) as AudioWorkerJobResponse;

    if (!response.ok) {
      return jsonError(
        workerErrorMessage(job.error || "The open-source audio worker could not read this transcription job."),
        response.status,
        {
          workerError: job.error,
          engine: audioEngineLabel(),
          quantizer: "grid",
        },
      );
    }

    if (job.state !== "completed") {
      return NextResponse.json(job);
    }

    if (!job.result?.midiBase64) {
      return jsonError("The audio worker finished without returning a MIDI file.", 502, {
        workerError: job.error,
        engine: job.result?.engine || audioEngineLabel(),
        quantizer: job.result?.quantizer || "grid",
      });
    }

    const transcription = await transcriptionPayloadFromWorkerResult(job.result, job.request || {});
    return NextResponse.json({
      ...job,
      transcription,
      result: {
        ...job.result,
        midiBase64: undefined,
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Open-source audio job polling failed.", 502, {
      engine: audioEngineLabel(),
    });
  }
}
