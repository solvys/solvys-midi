import { Midi } from "@tonejs/midi";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { makeWaveform, type PreviewNote } from "@/lib/preview";

export type ConvertedMidi = {
  bytes: Uint8Array;
  title: string;
  artist: string;
  year: string;
  genre: string;
  subGenre: string;
  durationSeconds: number;
  noteCount: number;
  partCount: number;
  previewNotes: PreviewNote[];
  waveform: number[];
};

export function retimeConvertedMidi(converted: ConvertedMidi, targetDurationSeconds: number): ConvertedMidi {
  if (converted.durationSeconds <= 0 || targetDurationSeconds <= 0) {
    return converted;
  }

  const scale = targetDurationSeconds / converted.durationSeconds;
  const midi = new Midi(converted.bytes);
  const currentTempo = midi.header.tempos[0]?.bpm || 96;
  midi.header.tempos = [];
  midi.header.setTempo(currentTempo / scale);

  const previewNotes = converted.previewNotes.map((note) => ({
    ...note,
    time: note.time * scale,
    duration: note.duration * scale,
  }));

  return {
    ...converted,
    bytes: midi.toArray(),
    durationSeconds: targetDurationSeconds,
    previewNotes,
    waveform: makeWaveform(previewNotes, targetDurationSeconds),
  };
}

type MusicNode = Record<string, unknown>;

const CLASSICAL_SUB_GENRES = [
  "Sonata",
  "Nocturne",
  "Prelude",
  "Fugue",
  "Etude",
  "Concerto",
  "Waltz",
  "Minuet",
  "Suite",
  "Variation",
  "Impromptu",
  "Mazurka",
  "Polonaise",
  "Fantasia",
  "Ragtime",
  "Chorale",
  "Canon",
  "Toccata",
  "Romance",
  "Ballade",
];

const STEP_TO_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function asObject(value: unknown): MusicNode {
  return value && typeof value === "object" ? (value as MusicNode) : {};
}

function text(value: unknown) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "object") {
    const node = value as MusicNode;
    return text(node["#text"] ?? node.text);
  }

  return String(value);
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pitchToMidi(note: MusicNode) {
  const pitch = asObject(note.pitch);
  const step = text(pitch.step).toUpperCase();
  const octave = numberValue(pitch.octave, 4);
  const alter = numberValue(pitch.alter, 0);
  const semitone = STEP_TO_SEMITONE[step];

  if (semitone === undefined) {
    return null;
  }

  return (octave + 1) * 12 + semitone + alter;
}

function getTempo(score: MusicNode) {
  const parts = asArray(score.part as MusicNode | MusicNode[]);
  for (const part of parts) {
    const measures = asArray(asObject(part).measure as MusicNode | MusicNode[]);
    for (const measure of measures) {
      const directions = asArray(asObject(measure).direction as MusicNode | MusicNode[]);
      for (const direction of directions) {
        const sound = asObject(direction).sound;
        const tempo = numberValue(asObject(sound).tempo, 0);
        if (tempo > 0) {
          return tempo;
        }
      }
    }
  }

  return 96;
}

function inferSubGenre(title: string) {
  const lower = title.toLowerCase();
  return CLASSICAL_SUB_GENRES.find((item) => lower.includes(item.toLowerCase())) ?? "Piano Solo";
}

function getCreator(score: MusicNode) {
  const identification = asObject(score.identification);
  const creators = asArray(asObject(identification).creator as MusicNode | MusicNode[]);
  const composer =
    creators.find((creator) => text(asObject(creator).type).toLowerCase() === "composer") ?? creators[0];

  return text(composer).trim();
}

function extractYear(score: MusicNode) {
  const identification = asObject(score.identification);
  const encoding = asObject(asObject(identification).encoding);
  const candidate = text(encoding["encoding-date"]) || text(score["movement-number"]);
  const year = candidate.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return year?.[0] ?? "";
}

async function extractMusicXmlFromZip(zip: JSZip) {
  const container = zip.file("META-INF/container.xml");

  if (container) {
    const xml = await container.async("text");
    const rootfile = xml.match(/full-path=["']([^"']+)["']/)?.[1];
    if (rootfile) {
      const root = zip.file(rootfile);
      if (root) {
        return root.async("text");
      }
    }
  }

  const firstXml = Object.values(zip.files).find((entry) => !entry.dir && entry.name.endsWith(".xml"));
  if (!firstXml) {
    throw new Error("No MusicXML score was found inside the MXL archive.");
  }

  return firstXml.async("text");
}

export async function readMusicXmlFromMxlBytes(bytes: ArrayBuffer | Uint8Array) {
  return extractMusicXmlFromZip(await JSZip.loadAsync(bytes));
}

async function readMxl(file: File) {
  return readMusicXmlFromMxlBytes(await file.arrayBuffer());
}

export async function readSheetMusicFile(file: File) {
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".mxl")) {
    return readMxl(file);
  }

  if (lower.endsWith(".xml") || lower.endsWith(".musicxml")) {
    return file.text();
  }

  throw new Error("This local build converts MusicXML or MXL files. PDF/image OMR needs a server-side recognition connector.");
}

export function convertMusicXmlToMidi(xml: string, filename = "score.musicxml"): ConvertedMidi {
  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    parseAttributeValue: true,
    parseTagValue: true,
    trimValues: true,
  });
  const parsed = parser.parse(xml) as MusicNode;
  const score = asObject(parsed["score-partwise"] ?? parsed["score-timewise"]);

  if (!Object.keys(score).length) {
    throw new Error("This does not look like a MusicXML score.");
  }

  const title =
    text(asObject(score.work)["work-title"]) ||
    text(score["movement-title"]) ||
    filename.replace(/\.(musicxml|xml|mxl)$/i, "");
  const artist = getCreator(score) || "Unknown composer";
  const year = extractYear(score);
  const tempo = getTempo(score);
  const secondsPerQuarter = 60 / tempo;
  const midi = new Midi();
  midi.header.setTempo(tempo);

  let noteCount = 0;
  let durationSeconds = 0;
  const previewNotes: PreviewNote[] = [];
  const parts = asArray(score.part as MusicNode | MusicNode[]);

  parts.forEach((part, partIndex) => {
    const track = midi.addTrack();
    track.name = text(asObject(part).id) || `Piano ${partIndex + 1}`;
    const measures = asArray(asObject(part).measure as MusicNode | MusicNode[]);
    let divisions = 1;
    let cursor = 0;
    let previousStart = 0;

    measures.forEach((measure) => {
      const attributes = asObject(asObject(measure).attributes);
      const nextDivisions = numberValue(attributes.divisions, divisions);
      divisions = nextDivisions > 0 ? nextDivisions : divisions;
      const events = Object.entries(measure).flatMap(([key, value]) => {
        if (!["note", "backup", "forward"].includes(key)) {
          return [];
        }

        return asArray(value as MusicNode | MusicNode[]).map((node) => ({ key, node: asObject(node) }));
      });

      events.forEach(({ key, node }) => {
        const durationQuarters = Math.max(numberValue(node.duration, 0) / divisions, 0);

        if (key === "backup") {
          cursor = Math.max(0, cursor - durationQuarters);
          return;
        }

        if (key === "forward") {
          cursor += durationQuarters;
          return;
        }

        const isChord = Object.prototype.hasOwnProperty.call(node, "chord");
        const startQuarters = isChord ? previousStart : cursor;
        const midiPitch = pitchToMidi(node);

        if (midiPitch !== null && !Object.prototype.hasOwnProperty.call(node, "rest")) {
          const noteDuration = Math.max(durationQuarters * secondsPerQuarter, 0.08);
          track.addNote({
            midi: midiPitch,
            time: startQuarters * secondsPerQuarter,
            duration: noteDuration,
            velocity: 0.78,
          });
          previewNotes.push({
            midi: midiPitch,
            time: startQuarters * secondsPerQuarter,
            duration: noteDuration,
            velocity: 0.78,
          });
          noteCount += 1;
          durationSeconds = Math.max(durationSeconds, startQuarters * secondsPerQuarter + noteDuration);
        }

        if (!isChord) {
          previousStart = startQuarters;
          cursor += durationQuarters;
        }
      });
    });
  });

  if (noteCount === 0) {
    throw new Error("No playable pitched notes were found in this score.");
  }

  return {
    bytes: midi.toArray(),
    title: title.trim(),
    artist,
    year,
    genre: "Classical",
    subGenre: inferSubGenre(title),
    durationSeconds,
    noteCount,
    partCount: Math.max(parts.length, 1),
    previewNotes,
    waveform: makeWaveform(previewNotes, durationSeconds),
  };
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function base64ToBlob(base64: string, type = "audio/midi") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
}

export function safeMidiFilename(title: string) {
  const cleaned = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${cleaned || "piano-score"}.mid`;
}
