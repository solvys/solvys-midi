import { NextRequest, NextResponse } from "next/server";
import {
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

type RouteContext = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const { jobId } = await context.params;
  const workerUrl = audioWorkerUrl();

  if (!workerUrl) {
    return jsonError("Open-source audio transcription is not configured.", 503, {
      engine: "Transkun",
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
          engine: "Transkun",
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
        engine: job.result?.engine || "Transkun",
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
      engine: "Transkun",
    });
  }
}
