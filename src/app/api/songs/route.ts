import { NextRequest, NextResponse } from "next/server";
import { del, list, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { safeMidiFilename } from "@/lib/musicxml";
import {
  cleanText,
  decodeBase64Payload,
  isMidiBytes,
  jsonError,
  numericEnv,
  rateLimit,
  readJsonBody,
  requireSameOrigin,
} from "@/lib/server/guards";

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

const SONG_POST_MAX_BYTES = numericEnv("SONG_POST_MAX_BYTES", 30 * 1024 * 1024);
const SONG_DELETE_MAX_BYTES = numericEnv("SONG_DELETE_MAX_BYTES", 4 * 1024);
const MIDI_MAX_BYTES = numericEnv("MIDI_MAX_BYTES", 10 * 1024 * 1024);
const SCORE_MAX_BYTES = numericEnv("SCORE_MAX_BYTES", 20 * 1024 * 1024);
const SONG_POSTS_PER_HOUR = numericEnv("SONG_POSTS_PER_HOUR", 24);
const SONG_DELETES_PER_HOUR = numericEnv("SONG_DELETES_PER_HOUR", 48);
const STORED_SONG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

const SCORE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.recordare.musicxml",
  "application/vnd.recordare.musicxml+xml",
  "application/xml",
  "text/xml",
]);

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

function safeStorageId(value: unknown) {
  const cleaned = cleanText(value, 120).replace(/[^\w-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || randomUUID();
}

function existingStorageId(value: unknown) {
  const id = cleanText(value, 120);
  return STORED_SONG_ID_RE.test(id) ? id : "";
}

function publicArray<T>(value: unknown, max: number) {
  return Array.isArray(value) ? (value.slice(0, max) as T[]) : undefined;
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
    .filter((song): song is PublicSongEntry => Boolean(song?.id && (song?.midiUrl || song?.midiDownloadUrl || song?.midiBase64)))
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  return NextResponse.json({ songs });
}

export async function POST(request: NextRequest) {
  const originRejection = requireSameOrigin(request);
  if (originRejection) {
    return originRejection;
  }

  const rateLimitRejection = rateLimit(request, {
    key: "songs:post",
    max: SONG_POSTS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (rateLimitRejection) {
    return rateLimitRejection;
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return jsonError("Shared song storage is not configured.", 503);
  }

  const parsed = await readJsonBody<PublicSongEntry | null>(request, SONG_POST_MAX_BYTES);
  if (parsed.error) {
    return parsed.error;
  }

  const incoming = parsed.body;
  const midiPayload = decodeBase64Payload(incoming?.midiBase64, MIDI_MAX_BYTES, "MIDI payload");
  if ("error" in midiPayload) {
    return jsonError(midiPayload.error, midiPayload.maxBytes ? 413 : 400, { maxBytes: midiPayload.maxBytes });
  }

  if (!isMidiBytes(midiPayload.bytes)) {
    return jsonError("MIDI payload is not a valid MIDI file.", 400);
  }

  const id = safeStorageId(incoming?.id);
  const title = cleanText(incoming?.title, 160) || "Untitled";
  const midiFilename = cleanText(incoming?.midiFilename, 180) || safeMidiFilename(title);
  const midiBlob = new Blob([new Uint8Array(midiPayload.bytes)], { type: "audio/midi" });
  const storedMidi = await put(midiPath(id, midiFilename), midiBlob, {
    access: "public",
    allowOverwrite: true,
    contentType: "audio/midi",
    cacheControlMaxAge: 60,
  });
  const scoreBase64 = cleanText(incoming?.scoreBase64, Number.MAX_SAFE_INTEGER);
  const scoreFilename = cleanText(incoming?.scoreFilename, 180) || cleanText(incoming?.sourceFile, 180) || `${title}.pdf`;
  const requestedScoreMimeType = cleanText(incoming?.scoreMimeType, 120) || "application/pdf";
  const scoreMimeType = SCORE_MIME_TYPES.has(requestedScoreMimeType) ? requestedScoreMimeType : "application/octet-stream";
  const scorePayload = scoreBase64
    ? decodeBase64Payload(scoreBase64, SCORE_MAX_BYTES, "Score payload")
    : null;
  if (scorePayload && "error" in scorePayload) {
    return jsonError(scorePayload.error, scorePayload.maxBytes ? 413 : 400, { maxBytes: scorePayload.maxBytes });
  }

  const storedScore = scoreBase64
    ? await put(scorePath(id, scoreFilename), new Blob([new Uint8Array(scorePayload!.bytes)], { type: scoreMimeType }), {
        access: "public",
        allowOverwrite: true,
        contentType: scoreMimeType,
        cacheControlMaxAge: 60,
      })
    : null;

  const song: PublicSongEntry = {
    id,
    title,
    artist: cleanText(incoming?.artist, 160) || "Unknown composer",
    year: cleanText(incoming?.year, 20) || new Date().getFullYear().toString(),
    genre: cleanText(incoming?.genre, 80) || "Classical",
    subGenre: cleanText(incoming?.subGenre, 120) || "Piano Solo",
    createdAt: cleanText(incoming?.createdAt, 40) || new Date().toISOString(),
    sourceFile: cleanText(incoming?.sourceFile, 180),
    youtubeUrl: cleanText(incoming?.youtubeUrl, 500),
    youtubeId: cleanText(incoming?.youtubeId, 80),
    midiFilename,
    midiBase64: undefined,
    midiUrl: storedMidi.url,
    midiDownloadUrl: storedMidi.downloadUrl,
    scoreBase64: undefined,
    scoreFilename,
    scoreMimeType,
    scoreUrl: storedScore?.url || cleanText(incoming?.scoreUrl, 800),
    scoreDownloadUrl: storedScore?.downloadUrl || cleanText(incoming?.scoreDownloadUrl, 800),
    durationSeconds: Number(incoming?.durationSeconds) || 0,
    noteCount: Number(incoming?.noteCount) || 0,
    partCount: Number(incoming?.partCount) || 0,
    previewNotes: publicArray(incoming?.previewNotes, 720),
    waveform: publicArray(incoming?.waveform, 96),
    musicXml: undefined,
    engine: cleanText(incoming?.engine, 120),
    quantizer: cleanText(incoming?.quantizer, 120),
    arrangement: cleanText(incoming?.arrangement, 160),
    arrangementStats: incoming?.arrangementStats,
    warnings: publicArray<string>(incoming?.warnings, 10),
    status: incoming?.status === "saved" ? "saved" : "ready",
  };

  await put(songPath(id), JSON.stringify(song), {
    access: "public",
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });

  return NextResponse.json({ song });
}

export async function DELETE(request: NextRequest) {
  const originRejection = requireSameOrigin(request);
  if (originRejection) {
    return originRejection;
  }

  const rateLimitRejection = rateLimit(request, {
    key: "songs:delete",
    max: SONG_DELETES_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (rateLimitRejection) {
    return rateLimitRejection;
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return jsonError("Shared song storage is not configured.", 503);
  }

  const parsed = await readJsonBody<{ id?: string } | null>(request, SONG_DELETE_MAX_BYTES);
  if (parsed.error) {
    return parsed.error;
  }

  const id = existingStorageId(parsed.body?.id);
  if (!id) {
    return jsonError("Song ID is invalid.", 400);
  }

  const [midiBlobs, scoreBlobs] = await Promise.all([
    list({ prefix: `library/midi/${id}-`, limit: 100 }),
    list({ prefix: `library/scores/${id}-`, limit: 100 }),
  ]);
  const paths = [
    songPath(id),
    ...midiBlobs.blobs.map((blob) => blob.pathname),
    ...scoreBlobs.blobs.map((blob) => blob.pathname),
  ];

  await del(Array.from(new Set(paths)));

  return NextResponse.json({
    deleted: true,
    id,
    removedBlobs: paths.length,
  });
}
