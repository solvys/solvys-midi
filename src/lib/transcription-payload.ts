import type { PreviewNote } from "@/lib/preview";

export type TranscriptionPayload = {
  storageId?: string;
  title: string;
  artist: string;
  year: string;
  genre: string;
  subGenre: string;
  midiFilename: string;
  durationSeconds: number;
  noteCount: number;
  partCount: number;
  midiBase64: string;
  previewNotes: PreviewNote[];
  waveform: number[];
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
};
