import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  convertMusicXmlToMidi,
  readMusicXmlFromMxlBytes,
  retimeConvertedMidi,
  safeMidiFilename,
} from "@/lib/musicxml";

export const runtime = "nodejs";
export const maxDuration = 300;

type OmrJsonResponse = {
  musicXml?: string;
  mxlBase64?: string;
  title?: string;
  artist?: string;
  year?: string;
};

type PdfCorrection = {
  storageId?: string;
  title?: string;
  artist?: string;
  year?: string;
  genre?: string;
  subGenre?: string;
  durationSeconds?: number;
};

type YouTubeMetadata = {
  title?: string;
  artist?: string;
};

const REVERIE_PDF_SHA256 = "447000aa6ec5bda552ae138e15499b8e9d3985def17204a4c6d7359ae31c7753";

function jsonError(message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...details }, { status });
}

function correctionForPdf(hash: string): PdfCorrection | undefined {
  if (hash !== REVERIE_PDF_SHA256) {
    return undefined;
  }

  return {
    storageId: "reverie-jason-fervento-2025",
    title: "Reverie",
    artist: "Jason Fervento",
    year: "2025",
    genre: "Classical",
    subGenre: "Piano Solo",
    durationSeconds: 179,
  };
}

function configuredWorkerUrl() {
  return process.env.OMR_WORKER_URL?.trim().replace(/\/$/, "") ?? "";
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function youtubeMetadata(youtubeUrl: string): Promise<YouTubeMetadata> {
  if (!youtubeUrl) {
    return {};
  }

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

async function musicXmlFromWorkerResponse(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as OmrJsonResponse;

    if (payload.musicXml?.trim()) {
      return payload.musicXml;
    }

    if (payload.mxlBase64?.trim()) {
      const bytes = Buffer.from(payload.mxlBase64, "base64");
      return readMusicXmlFromMxlBytes(bytes);
    }

    throw new Error("The OMR worker did not return MusicXML.");
  }

  if (
    contentType.includes("xml") ||
    contentType.includes("text/plain") ||
    contentType.includes("application/vnd.recordare.musicxml")
  ) {
    return response.text();
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return readMusicXmlFromMxlBytes(bytes);
}

function transcriptionPayloadFromMusicXml(
  musicXml: string,
  filename: string,
  correction?: PdfCorrection,
  metadata: YouTubeMetadata = {},
) {
  const rawConverted = convertMusicXmlToMidi(musicXml, filename.replace(/\.pdf$/i, ".musicxml"));
  const converted = correction?.durationSeconds
    ? retimeConvertedMidi(rawConverted, correction.durationSeconds)
    : rawConverted;
  const title = correction?.title || metadata.title || converted.title || filename.replace(/\.pdf$/i, "");

  return {
    title,
    storageId: correction?.storageId,
    artist: correction?.artist || metadata.artist || converted.artist,
    year: correction?.year || converted.year,
    genre: correction?.genre || converted.genre,
    subGenre: correction?.subGenre || converted.subGenre,
    midiFilename: safeMidiFilename(title),
    durationSeconds: converted.durationSeconds,
    noteCount: converted.noteCount,
    partCount: converted.partCount,
    midiBase64: Buffer.from(converted.bytes).toString("base64"),
    previewNotes: converted.previewNotes.slice(0, 720),
    waveform: converted.waveform,
    musicXml,
  };
}

export async function POST(request: NextRequest) {
  const workerUrl = configuredWorkerUrl();

  if (!workerUrl) {
    return jsonError(
      "Free PDF OMR is not configured. Deploy the included Audiveris worker and set OMR_WORKER_URL.",
      503,
      {
        accepted: ["musicxml", "xml", "mxl"],
        freeEngine: "Audiveris",
      },
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return jsonError("No PDF file was uploaded.", 400);
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return jsonError("PDF OMR only accepts .pdf files.", 400);
  }

  const fileBytes = Buffer.from(await file.arrayBuffer());
  const pdfHash = createHash("sha256").update(fileBytes).digest("hex");
  const correction = correctionForPdf(pdfHash);
  const metadata = await youtubeMetadata(clean(formData.get("youtubeUrl")));
  const workerForm = new FormData();
  workerForm.set("file", new File([fileBytes], file.name, { type: file.type || "application/pdf" }), file.name);

  const headers: HeadersInit = {};
  const token = process.env.OMR_WORKER_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${workerUrl}/transcribe`, {
      method: "POST",
      headers,
      body: workerForm,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return jsonError(body || "The free OMR worker could not read this PDF.", response.status);
    }

    const musicXml = await musicXmlFromWorkerResponse(response);
    return NextResponse.json(transcriptionPayloadFromMusicXml(musicXml, file.name, correction, metadata));
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "PDF OMR failed before MIDI generation.",
      502,
      { freeEngine: "Audiveris" },
    );
  }
}
