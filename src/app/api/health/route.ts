import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function omrWorkerStatus() {
  const workerUrl = process.env.OMR_WORKER_URL?.trim().replace(/\/$/, "");
  if (!workerUrl) {
    return "setup";
  }

  try {
    const response = await fetch(`${workerUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
      headers: process.env.OMR_WORKER_TOKEN
        ? { authorization: `Bearer ${process.env.OMR_WORKER_TOKEN}` }
        : undefined,
    });
    return response.ok ? "online" : "offline";
  } catch {
    return "offline";
  }
}

async function audioWorkerStatus() {
  const workerUrl = process.env.AUDIO_TRANSCRIPTION_WORKER_URL?.trim().replace(/\/$/, "");
  if (!workerUrl) {
    return "setup";
  }

  try {
    const response = await fetch(`${workerUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
      headers: process.env.AUDIO_TRANSCRIPTION_WORKER_TOKEN
        ? { authorization: `Bearer ${process.env.AUDIO_TRANSCRIPTION_WORKER_TOKEN}` }
        : undefined,
    });
    return response.ok ? "online" : "offline";
  } catch {
    return "offline";
  }
}

export async function GET() {
  return NextResponse.json({
    api: "online",
    omr: await omrWorkerStatus(),
    audio: await audioWorkerStatus(),
    backend: "online",
  });
}
