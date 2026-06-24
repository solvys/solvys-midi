import { NextRequest, NextResponse } from "next/server";
import { list, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { base64ToBlob, safeMidiFilename } from "@/lib/musicxml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PublicSongEntry = {
  id?: string;
  title?: string;
  artist?: string;
  year?: string;
  genre?: string;
  subGenre?: string;
  createdAt?: string;
  sourceFile?: string;
  youtubeUrl?: string;
  youtubeId?: string;
  midiBase64?: string;
  midiFilename?: string;
  midiUrl?: string;
  midiDownloadUrl?: string;
  scoreBase64?: string;
  scoreFilename?: string;
  scoreMimeType?: string;
  scoreUrl?: string;
  scoreDownloadUrl?: string;
  durationSeconds?: number;
  noteCount?: number;
  partCount?: number;
  previewNotes?: unknown[];
  waveform?: number[];
  musicXml?: string;
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
  warnings?: string[];
  status?: string;
};

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function songPath(id: string) {
  return `library/songs/${id}.json`;
}

function midiPath(id: string, filename: string) {
  return `library/midi/${id}-${safeMidiFilename(filename || "SolvysMIDI")}`;
}

function scorePath(id: string, filename: string) {
  const cleaned = filename
    .trim()
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
  return `library/scores/${id}-${cleaned || "score.pdf"}`;
}

async function readJsonBlob(url: string) {
  const freshUrl = new URL(url);
  freshUrl.searchParams.set("v", Date.now().toString());
  const response = await fetch(freshUrl, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  return (await response.json().catch(() => null)) as PublicSongEntry | null;
}

export async function GET() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ songs: [] });
  }

  const result = await list({ prefix: "library/songs/", limit: 100 });
  const songs = (await Promise.all(result.blobs.map((blob) => readJsonBlob(blob.url))))
    .filter((song): song is PublicSongEntry => Boolean(song?.id && song?.midiBase64))
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  return NextResponse.json({ songs });
}

export async function POST(request: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return jsonError("Shared song storage is not configured.", 503);
  }

  const incoming = (await request.json().catch(() => null)) as PublicSongEntry | null;
  if (!incoming?.midiBase64) {
    return jsonError("A MIDI payload is required.", 400);
  }

  const id = clean(incoming.id) || randomUUID();
  const title = clean(incoming.title) || "Untitled";
  const midiFilename = clean(incoming.midiFilename) || safeMidiFilename(title);
  const midiBlob = base64ToBlob(incoming.midiBase64);
  const storedMidi = await put(midiPath(id, midiFilename), midiBlob, {
    access: "public",
    allowOverwrite: true,
    contentType: "audio/midi",
    cacheControlMaxAge: 60,
  });
  const scoreBase64 = clean(incoming.scoreBase64);
  const scoreFilename = clean(incoming.scoreFilename) || clean(incoming.sourceFile) || `${title}.pdf`;
  const scoreMimeType = clean(incoming.scoreMimeType) || "application/pdf";
  const storedScore = scoreBase64
    ? await put(scorePath(id, scoreFilename), base64ToBlob(scoreBase64, scoreMimeType), {
        access: "public",
        allowOverwrite: true,
        contentType: scoreMimeType,
        cacheControlMaxAge: 60,
      })
    : null;

  const song: PublicSongEntry = {
    ...incoming,
    id,
    title,
    artist: clean(incoming.artist) || "Unknown composer",
    year: clean(incoming.year) || new Date().getFullYear().toString(),
    genre: clean(incoming.genre) || "Classical",
    subGenre: clean(incoming.subGenre) || "Piano Solo",
    createdAt: clean(incoming.createdAt) || new Date().toISOString(),
    midiFilename,
    midiUrl: storedMidi.url,
    midiDownloadUrl: storedMidi.downloadUrl,
    scoreBase64: undefined,
    scoreFilename,
    scoreMimeType,
    scoreUrl: storedScore?.url || incoming.scoreUrl,
    scoreDownloadUrl: storedScore?.downloadUrl || incoming.scoreDownloadUrl,
    status: incoming.status === "saved" ? "saved" : "ready",
  };

  await put(songPath(id), JSON.stringify(song), {
    access: "public",
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });

  return NextResponse.json({ song });
}
