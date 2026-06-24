import { Midi } from "@tonejs/midi";
import { makeWaveform, type PreviewNote } from "@/lib/preview";
import { safeMidiFilename } from "@/lib/musicxml";
import type { TranscriptionPayload } from "@/lib/transcription-payload";

type MidiSummaryMetadata = {
  title?: string;
  artist?: string;
  year?: string;
  genre?: string;
  subGenre?: string;
  filename?: string;
  musicXml?: string;
};

function clean(value: string | undefined) {
  return value?.trim() ?? "";
}

function filenameToTitle(filename: string | undefined) {
  return clean(filename)
    .replace(/\.(mid|midi)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

export function midiBytesToTranscriptionPayload(
  bytes: Uint8Array,
  metadata: MidiSummaryMetadata = {},
): TranscriptionPayload {
  const midi = new Midi(bytes);
  const notes: PreviewNote[] = midi.tracks.flatMap((track) =>
    track.name === "Timeline"
      ? []
      : track.notes.map((note) => ({
          midi: note.midi,
          time: note.time,
          duration: Math.max(note.duration, 0.06),
          velocity: note.velocity || 0.72,
        })),
  );
  const durationSeconds =
    midi.duration || notes.reduce((duration, note) => Math.max(duration, note.time + note.duration), 0);
  const title = clean(metadata.title) || clean(midi.name) || filenameToTitle(metadata.filename) || "Audio transcription";
  const partCount = Math.max(
    midi.tracks.filter((track) => track.name !== "Timeline" && track.notes.length > 0).length,
    1,
  );

  if (!notes.length) {
    throw new Error("The transcription returned a MIDI file, but it did not contain playable notes.");
  }

  return {
    title,
    artist: clean(metadata.artist) || "YouTube",
    year: clean(metadata.year),
    genre: clean(metadata.genre) || "Classical",
    subGenre: clean(metadata.subGenre) || "Piano Solo",
    midiFilename: safeMidiFilename(title),
    durationSeconds,
    noteCount: notes.length,
    partCount,
    midiBase64: Buffer.from(bytes).toString("base64"),
    previewNotes: notes.slice(0, 720),
    waveform: makeWaveform(notes, durationSeconds),
    musicXml: metadata.musicXml,
  };
}
