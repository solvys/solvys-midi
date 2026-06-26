"use client";

import {
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  Library,
  ListFilter,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  Settings,
  Trash2,
  Upload,
} from "lucide-react";
import Image from "next/image";
import { FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  base64ToBlob,
  bytesToBase64,
  convertMusicXmlToMidi,
  readSheetMusicFile,
  safeMidiFilename,
} from "@/lib/musicxml";
import type { TranscriptionPayload } from "@/lib/transcription-payload";
import {
  downloadBlob,
  getDirectoryHandle,
  pickDirectory,
  shareMidiFile,
  supportsDirectoryPicker,
  writeMidiFile,
  type DirectoryKey,
} from "@/lib/file-handles";
import { getYouTubeId, getYouTubeThumbnailUrl } from "@/lib/youtube";
import { midiToFrequency, type PreviewNote } from "@/lib/preview";

type TabId = "songs" | "new" | "settings";
type ThemeMode = "dark" | "khaki";
type IoMode = "automatic" | "manual";
type SortKey = "recent" | "artist" | "year" | "genre" | "subGenre";
type SongStatus = "ready" | "saved";
type ServiceStatus = "checking" | "online" | "setup" | "offline";
type ExportKind = "midi" | "score";

type SongEntry = {
  id: string;
  title: string;
  artist: string;
  year: string;
  genre: string;
  subGenre: string;
  createdAt: string;
  sourceFile: string;
  youtubeUrl: string;
  youtubeId: string;
  midiBase64?: string;
  midiFilename: string;
  midiUrl?: string;
  midiDownloadUrl?: string;
  scoreBase64?: string;
  scoreFilename?: string;
  scoreMimeType?: string;
  scoreUrl?: string;
  scoreDownloadUrl?: string;
  durationSeconds: number;
  noteCount: number;
  partCount: number;
  previewNotes?: PreviewNote[];
  waveform?: number[];
  musicXml?: string;
  engine?: string;
  quantizer?: string;
  arrangement?: string;
  arrangementStats?: TranscriptionPayload["arrangementStats"];
  warnings?: string[];
  status: SongStatus;
};

type AppSettings = {
  theme: ThemeMode;
  exportPathLabel: string;
  importPathLabel: string;
  ioMode: IoMode;
};

type HealthState = {
  api: ServiceStatus;
  audio: ServiceStatus;
  backend: ServiceStatus;
};

type AudioJobPayload = {
  jobId?: string;
  state?: "queued" | "running" | "completed" | "failed";
  status?: string;
  transcription?: TranscriptionPayload;
  error?: string;
  workerError?: string;
};

type ConversionFlow = "youtube" | "pdf" | "score";
type ConversionStepState = "pending" | "active" | "complete" | "error";

type ConversionStep = {
  id: string;
  label: string;
  detail: string;
  percent: number;
  state: ConversionStepState;
};

const HISTORY_KEY = "solvys-midi-history-v1";
const SETTINGS_KEY = "solvys-midi-settings-v1";
const DELETED_SONGS_KEY = "solvys-midi-deleted-song-ids-v1";
const DEFAULT_BOARD_FOLDER = "~/iCloud Drive/MIDI Board";

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  exportPathLabel: DEFAULT_BOARD_FOLDER,
  importPathLabel: DEFAULT_BOARD_FOLDER,
  ioMode: "manual",
};

const DEFAULT_HEALTH: HealthState = {
  api: "checking",
  audio: "checking",
  backend: "checking",
};

const CONVERSION_STEPS: Record<ConversionFlow, Array<Omit<ConversionStep, "state" | "detail">>> = {
  youtube: [
    { id: "queue", label: "Queue import", percent: 8 },
    { id: "download", label: "Download YouTube audio", percent: 24 },
    { id: "transcribe", label: "Transcribe audio", percent: 62 },
    { id: "arrange", label: "Arrange piano MIDI", percent: 82 },
    { id: "store", label: "Store result", percent: 94 },
    { id: "metadata", label: "Fill song info", percent: 100 },
  ],
  pdf: [
    { id: "read", label: "Read score file", percent: 14 },
    { id: "upload", label: "Upload PDF", percent: 34 },
    { id: "transcribe", label: "Transcribe sheet music", percent: 68 },
    { id: "write", label: "Write MIDI", percent: 84 },
    { id: "store", label: "Store result", percent: 94 },
    { id: "metadata", label: "Fill song info", percent: 100 },
  ],
  score: [
    { id: "read", label: "Read score file", percent: 18 },
    { id: "parse", label: "Parse notation", percent: 52 },
    { id: "write", label: "Write MIDI", percent: 82 },
    { id: "store", label: "Store result", percent: 94 },
    { id: "metadata", label: "Fill song info", percent: 100 },
  ],
};

function loadSettings() {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      exportPathLabel:
        !stored.exportPathLabel || stored.exportPathLabel === "Downloads"
          ? DEFAULT_BOARD_FOLDER
          : stored.exportPathLabel,
      importPathLabel:
        !stored.importPathLabel || stored.importPathLabel === "Choose folder"
          ? DEFAULT_BOARD_FOLDER
          : stored.importPathLabel,
    } as AppSettings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadHistory() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const deletedSongIds = loadDeletedSongIds();
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "null") as SongEntry[] | null;
    return Array.isArray(stored)
      ? stored
          .filter(
            (song) =>
              Boolean(
                song.sourceFile &&
                  (song.midiBase64 || song.midiUrl || song.midiDownloadUrl) &&
                  String(song.status) !== "sample",
              ) &&
              !deletedSongIds.has(song.id),
          )
          .map((song) => ({
            ...song,
            midiBase64: song.midiBase64 ?? "",
            midiUrl: song.midiUrl ?? "",
            midiDownloadUrl: song.midiDownloadUrl ?? "",
            status: (song.status === "saved" ? "saved" : "ready") as SongStatus,
            previewNotes: song.previewNotes ?? [],
            waveform: song.waveform ?? [],
            musicXml: song.musicXml ?? "",
            scoreBase64: song.scoreBase64 ?? "",
            scoreFilename: song.scoreFilename ?? "",
            scoreMimeType: song.scoreMimeType ?? "",
            scoreUrl: song.scoreUrl ?? "",
            scoreDownloadUrl: song.scoreDownloadUrl ?? "",
            engine: song.engine ?? "",
            quantizer: song.quantizer ?? "",
            arrangement: song.arrangement ?? "",
            arrangementStats: song.arrangementStats,
            warnings: song.warnings ?? [],
          }))
      : [];
  } catch {
    return [];
  }
}

function loadDeletedSongIds() {
  if (typeof window === "undefined") {
    return new Set<string>();
  }

  try {
    const stored = JSON.parse(localStorage.getItem(DELETED_SONGS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function rememberDeletedSong(songId: string) {
  if (typeof window === "undefined" || !songId) {
    return;
  }

  const deletedSongIds = loadDeletedSongIds();
  deletedSongIds.add(songId);
  localStorage.setItem(DELETED_SONGS_KEY, JSON.stringify(Array.from(deletedSongIds)));
}

function mergeSongs(primary: SongEntry[], secondary: SongEntry[]) {
  const byId = new Map<string, SongEntry>();
  [...primary, ...secondary].forEach((song) => {
    if (!song.id || byId.has(song.id)) {
      return;
    }

    byId.set(song.id, {
      ...song,
      midiBase64: song.midiBase64 ?? "",
      midiUrl: song.midiUrl ?? "",
      midiDownloadUrl: song.midiDownloadUrl ?? "",
      status: (song.status === "saved" ? "saved" : "ready") as SongStatus,
      previewNotes: song.previewNotes ?? [],
      waveform: song.waveform ?? [],
      musicXml: song.musicXml ?? "",
      scoreBase64: song.scoreBase64 ?? "",
      scoreFilename: song.scoreFilename ?? "",
      scoreMimeType: song.scoreMimeType ?? "",
      scoreUrl: song.scoreUrl ?? "",
      scoreDownloadUrl: song.scoreDownloadUrl ?? "",
      engine: song.engine ?? "",
      quantizer: song.quantizer ?? "",
      arrangement: song.arrangement ?? "",
      arrangementStats: song.arrangementStats,
      warnings: song.warnings ?? [],
    });
  });

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function byString(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function artworkClass(song: SongEntry) {
  const seed = `${song.title} ${song.artist}`.length % 5;
  return `artwork artwork-${seed}`;
}

function artworkInitials(song: SongEntry) {
  return song.title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function SongArtwork({ song, size = "row" }: { song: SongEntry; size?: "hero" | "row" | "mini" }) {
  const thumbnailUrl = getYouTubeThumbnailUrl(song.youtubeId || song.youtubeUrl);
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState("");
  const showThumbnail = Boolean(thumbnailUrl && failedThumbnailUrl !== thumbnailUrl);

  return (
    <span className={`${artworkClass(song)} songArtwork songArtwork-${size}`} aria-hidden="true">
      {showThumbnail ? (
        <Image
          src={thumbnailUrl}
          alt=""
          fill
          priority={size === "hero"}
          sizes={size === "hero" ? "96px" : "64px"}
          onError={() => setFailedThumbnailUrl(thumbnailUrl)}
        />
      ) : (
        <span className="artworkFallback">
          <Music2 size={size === "hero" ? 26 : 20} />
          <b>{artworkInitials(song) || "SM"}</b>
        </span>
      )}
    </span>
  );
}

function SongRowWaveform({
  waveform,
  active,
  progressIndex,
}: {
  waveform: number[];
  active: boolean;
  progressIndex: number;
}) {
  if (!waveform.length) {
    return <span className="rowWaveform rowWaveformEmpty" aria-hidden="true" />;
  }

  return (
    <span className="rowWaveform" aria-hidden="true">
      {waveform.slice(0, 46).map((bar, index) => (
        <span
          className={active && index <= progressIndex ? "rowWaveformBar rowWaveformBarActive" : "rowWaveformBar"}
          style={{ height: `${Math.max(4, bar * 22)}px` }}
          key={`${bar}-${index}`}
        />
      ))}
    </span>
  );
}

function SortButton({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: SortKey;
  active: SortKey;
  onClick: (value: SortKey) => void;
}) {
  return (
    <button className={active === value ? "sortChip sortChipActive" : "sortChip"} onClick={() => onClick(value)} type="button">
      {label}
    </button>
  );
}

function FooterStatus({ label, status }: { label: string; status: ServiceStatus }) {
  return (
    <span className={`footerStatus footerStatus-${status}`} title={`${label}: ${status}`}>
      <i aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function ConversionProgressPanel({
  steps,
  visible,
}: {
  steps: ConversionStep[];
  visible: boolean;
}) {
  if (!steps.length) {
    return null;
  }

  const percent = Math.max(0, Math.min(100, Math.max(...steps.map((step) => step.state === "pending" ? 0 : step.percent))));

  return (
    <section className={visible ? "conversionProgress" : "conversionProgress conversionProgressHidden"} aria-live="polite">
      <div className="conversionProgressHeader">
        <span>Conversion</span>
        <strong>{percent}%</strong>
      </div>
      <div className="conversionProgressTrack" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <ol className="conversionStepList">
        {steps.map((step) => (
          <li className={`conversionStep conversionStep-${step.state}`} key={step.id}>
            <span className="conversionStepIcon" aria-hidden="true">
              {step.state === "complete" ? <Check size={14} /> : null}
            </span>
            <span>
              <strong>{step.label}</strong>
              {step.detail ? <small>{step.detail}</small> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function SolvysMidiApp() {
  const [activeTab, setActiveTab] = useState<TabId>("songs");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [songs, setSongs] = useState<SongEntry[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewSongId, setPreviewSongId] = useState("");
  const [previewProgress, setPreviewProgress] = useState(0);
  const [youtubePreviewSongId, setYoutubePreviewSongId] = useState("");
  const [exportMenuOpenFor, setExportMenuOpenFor] = useState("");
  const [swipedSongId, setSwipedSongId] = useState("");
  const [swipingSongId, setSwipingSongId] = useState("");
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [conversionSteps, setConversionSteps] = useState<ConversionStep[]>([]);
  const [conversionProgressVisible, setConversionProgressVisible] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [health, setHealth] = useState<HealthState>(DEFAULT_HEALTH);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [fileName, setFileName] = useState("");
  const [formState, setFormState] = useState({
    title: "",
    artist: "",
    year: "",
    genre: "Classical",
    subGenre: "Piano Solo",
    youtubeUrl: "",
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const stopPreviewRef = useRef<(() => void) | null>(null);
  const progressFadeTimerRef = useRef<number | null>(null);
  const progressClearTimerRef = useRef<number | null>(null);
  const swipeRef = useRef({
    pointerId: -1,
    startX: 0,
    startY: 0,
    offset: 0,
    axis: "" as "" | "x" | "y",
    moved: false,
  });

  useEffect(() => {
    let canceled = false;

    window.setTimeout(() => {
      const loadedSettings = loadSettings();
      const loadedHistory = loadHistory();
      if (canceled) {
        return;
      }
      setSettings(loadedSettings);
      setSongs(loadedHistory);
      setSelectedId(loadedHistory[0]?.id ?? "");
      setStorageLoaded(true);

      fetch("/api/songs", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error("Shared library unavailable");
          }
          return (await response.json()) as { songs?: SongEntry[] };
        })
        .then((payload) => {
          if (canceled) {
            return;
          }

          const deletedSongIds = loadDeletedSongIds();
          const sharedSongs = Array.isArray(payload.songs)
            ? payload.songs.filter((song) => !deletedSongIds.has(song.id))
            : [];
          if (!sharedSongs.length) {
            return;
          }

          setSongs((current) => {
            const merged = mergeSongs(sharedSongs, current);
            setSelectedId((selected) => selected || merged[0]?.id || "");
            return merged;
          });
        })
        .catch(() => undefined);
    }, 0);

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageLoaded) {
      return;
    }

    document.documentElement.dataset.theme = settings.theme;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings, storageLoaded]);

  useEffect(() => {
    if (!storageLoaded) {
      return;
    }

    localStorage.setItem(HISTORY_KEY, JSON.stringify(songs));
  }, [songs, storageLoaded]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    let canceled = false;

    fetch("/api/health", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Health check failed");
        }
        return (await response.json()) as Partial<HealthState>;
      })
      .then((payload) => {
        if (canceled) {
          return;
        }
        setHealth({
          api: payload.api ?? "offline",
          audio: payload.audio ?? "offline",
          backend: payload.backend ?? "offline",
        });
      })
      .catch(() => {
        if (!canceled) {
          setHealth({ api: "offline", audio: "offline", backend: "offline" });
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!supportsDirectoryPicker()) {
      return;
    }

    getDirectoryHandle("exportDirectory")
      .then((handle) => {
        if (handle) {
          setSettings((current) => ({ ...current, exportPathLabel: handle.name }));
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    return () => {
      stopPreviewRef.current?.();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      audioContextRef.current?.close().catch(() => undefined);
      if (progressFadeTimerRef.current !== null) {
        window.clearTimeout(progressFadeTimerRef.current);
      }
      if (progressClearTimerRef.current !== null) {
        window.clearTimeout(progressClearTimerRef.current);
      }
    };
  }, []);

  const selectedSong = useMemo(
    () => songs.find((song) => song.id === selectedId) ?? songs[0] ?? null,
    [songs, selectedId],
  );

  const sortedSongs = useMemo(() => {
    return [...songs].sort((a, b) => {
      if (sortKey === "recent") {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }

      if (sortKey === "year") {
        return Number(a.year || 0) - Number(b.year || 0) || byString(a.title, b.title);
      }

      return byString(a[sortKey], b[sortKey]) || byString(a.title, b.title);
    });
  }, [songs, sortKey]);

  function updateForm(key: keyof typeof formState, value: string) {
    setFormState((current) => ({ ...current, [key]: value }));
  }

  function clearProgressTimers() {
    if (progressFadeTimerRef.current !== null) {
      window.clearTimeout(progressFadeTimerRef.current);
      progressFadeTimerRef.current = null;
    }
    if (progressClearTimerRef.current !== null) {
      window.clearTimeout(progressClearTimerRef.current);
      progressClearTimerRef.current = null;
    }
  }

  function startConversionProgress(flow: ConversionFlow, firstStepId: string) {
    clearProgressTimers();
    setConversionProgressVisible(true);
    setConversionSteps(
      CONVERSION_STEPS[flow].map((step) => ({
        ...step,
        detail: step.id === firstStepId ? "Starting" : "",
        state: step.id === firstStepId ? "active" : "pending",
      })),
    );
  }

  function setProgressStep(stepId: string, state: ConversionStepState, detail = "") {
    setConversionSteps((current) =>
      current.map((step) =>
        step.id === stepId
          ? {
              ...step,
              detail,
              state,
            }
          : step,
      ),
    );
  }

  function completeProgressStep(stepId: string, detail = "Done") {
    setProgressStep(stepId, "complete", detail);
  }

  function activateProgressStep(stepId: string, detail = "Working") {
    setConversionProgressVisible(true);
    setProgressStep(stepId, "active", detail);
  }

  function failProgress(message: string) {
    setConversionProgressVisible(true);
    setConversionSteps((current) =>
      current.map((step) =>
        step.state === "active"
          ? {
              ...step,
              detail: message,
              state: "error",
            }
          : step,
      ),
    );
  }

  function finishProgress(message = "Complete", onSettled?: () => void) {
    setConversionSteps((current) =>
      current.map((step) => ({
        ...step,
        detail: step.detail || message,
        state: "complete",
      })),
    );
    setConversionProgressVisible(true);
    clearProgressTimers();
    progressFadeTimerRef.current = window.setTimeout(() => {
      setConversionProgressVisible(false);
    }, 1400);
    progressClearTimerRef.current = window.setTimeout(() => {
      setConversionSteps([]);
      onSettled?.();
    }, 2100);
  }

  function syncYoutubeProgress(workerStatus = "") {
    const normalized = workerStatus.toLowerCase();
    if (/download/.test(normalized)) {
      completeProgressStep("queue", "Queued");
      activateProgressStep("download", workerStatus);
      return;
    }
    if (/prepar/.test(normalized)) {
      completeProgressStep("download", "Audio ready");
      activateProgressStep("transcribe", workerStatus);
      return;
    }
    if (/pitch|transkun|transcrib/.test(normalized)) {
      completeProgressStep("download", "Audio ready");
      activateProgressStep("transcribe", workerStatus);
      return;
    }
    if (/arrang/.test(normalized)) {
      completeProgressStep("transcribe", "Notes detected");
      activateProgressStep("arrange", workerStatus);
      return;
    }
    if (/ready|midi/.test(normalized)) {
      completeProgressStep("download", "Audio ready");
      completeProgressStep("transcribe", "Notes detected");
      completeProgressStep("arrange", "MIDI ready");
    }
  }

  function fillFormFromResult(result: Partial<TranscriptionPayload> & Partial<ReturnType<typeof convertMusicXmlToMidi>>) {
    setFormState((current) => ({
      ...current,
      title: current.title.trim() || result.title || current.title,
      artist: current.artist.trim() || result.artist || current.artist,
      year: current.year.trim() || result.year || new Date().getFullYear().toString(),
      genre: current.genre || result.genre || "Classical",
      subGenre: current.subGenre || result.subGenre || "Piano Solo",
    }));
  }

  function revealCompletedSong(songId: string) {
    setSelectedId(songId);
    setActiveTab("songs");
    setDrawerOpen(false);
  }

  function scoreMimeType(file: File) {
    if (file.type) {
      return file.type;
    }

    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pdf")) {
      return "application/pdf";
    }
    if (lower.endsWith(".mxl")) {
      return "application/vnd.recordare.musicxml";
    }
    if (lower.endsWith(".xml") || lower.endsWith(".musicxml")) {
      return "application/vnd.recordare.musicxml+xml";
    }

    return "application/octet-stream";
  }

  async function scoreAssetFromFile(file: File) {
    return {
      scoreBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      scoreFilename: file.name,
      scoreMimeType: scoreMimeType(file),
    };
  }

  function stopPreview() {
    stopPreviewRef.current?.();
    stopPreviewRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setIsPlaying(false);
    setPreviewSongId("");
    setYoutubePreviewSongId("");
    setPreviewProgress(0);
  }

  function youtubeAutoplayUrl(song: SongEntry) {
    const id = getYouTubeId(song.youtubeUrl || song.youtubeId);
    if (!id || typeof window === "undefined") {
      return "";
    }

    const params = new URLSearchParams({
      autoplay: "1",
      controls: "0",
      enablejsapi: "1",
      playsinline: "1",
      rel: "0",
      origin: window.location.origin,
    });

    return `https://www.youtube.com/embed/${id}?${params.toString()}`;
  }

  async function getAudioContext() {
    const AudioContextConstructor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextConstructor) {
      throw new Error("Audio preview is unavailable in this browser.");
    }

    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContextConstructor();
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }

  async function togglePreview(song: SongEntry) {
    if (isPlaying && previewSongId === song.id) {
      stopPreview();
      return;
    }

    stopPreview();

    const youtubeId = getYouTubeId(song.youtubeUrl || song.youtubeId);
    const duration = youtubeId ? Math.min(30, Math.max(song.durationSeconds || 30, 1)) : Math.max(song.durationSeconds || 0, 1);
    let startedAt = 0;
    const notes = song.previewNotes ?? [];
    setIsPlaying(true);
    setPreviewSongId(song.id);
    setPreviewProgress(0);
    setStatus(youtubeId ? `Playing YouTube audio preview for ${song.title}` : `Previewing generated MIDI for ${song.title}`);

    const tick = (timestamp: number) => {
      if (!startedAt) {
        startedAt = timestamp;
      }

      const progress = Math.min(1, (timestamp - startedAt) / (duration * 1000));
      setPreviewProgress(progress);
      if (progress >= 1) {
        stopPreview();
        setStatus("Preview complete");
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    if (youtubeId) {
      setYoutubePreviewSongId(song.id);
      stopPreviewRef.current = () => undefined;
      return;
    }

    if (!notes.length) {
      stopPreviewRef.current = () => undefined;
      return;
    }

    try {
      const context = await getAudioContext();
      const startAt = context.currentTime + 0.05;
      const scheduled: OscillatorNode[] = [];

      notes.slice(0, 360).forEach((note) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const noteStart = startAt + note.time;
        const noteEnd = noteStart + Math.max(note.duration, 0.06);
        oscillator.type = note.midi < 48 ? "triangle" : "sine";
        oscillator.frequency.setValueAtTime(midiToFrequency(note.midi), noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.03, note.velocity * 0.11), noteStart + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteEnd + 0.03);
        scheduled.push(oscillator);
      });

      stopPreviewRef.current = () => {
        scheduled.forEach((oscillator) => {
          try {
            oscillator.stop();
          } catch {
            // The oscillator may already have ended.
          }
        });
      };
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Audio preview unavailable");
    }
  }

  async function transcribePdf(file: File) {
    const body = new FormData();
    body.set("file", file);
    body.set("youtubeUrl", formState.youtubeUrl.trim());
    const response = await fetch("/api/transcribe", { method: "POST", body });
    const payload = (await response.json()) as TranscriptionPayload & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error || "PDF transcription failed");
    }

    return payload;
  }

  async function saveSharedSong(song: SongEntry) {
    const response = await fetch("/api/songs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(song),
    });
    const payload = (await response.json().catch(() => ({}))) as { song?: SongEntry; error?: string };

    if (!response.ok || !payload.song) {
      throw new Error(payload.error || "Shared library save failed");
    }

    setSongs((current) => mergeSongs([payload.song as SongEntry], current));
    return payload.song;
  }

  async function transcribeYoutube() {
    const startResponse = await fetch("/api/audio/youtube/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(formState),
    });
    const startPayload = (await startResponse.json()) as AudioJobPayload;

    if (!startResponse.ok || !startPayload.jobId) {
      throw new Error(startPayload.error || "Open-source audio import failed");
    }

    setStatus(startPayload.status || "Audio transcription queued");
    completeProgressStep("queue", "Queued");
    activateProgressStep("download", startPayload.status || "Waiting for audio worker");

    const startedAt = Date.now();
    const timeoutMs = 20 * 60 * 1000;
    let lastStatus = startPayload.status || "";

    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 5000));
      const response = await fetch(`/api/audio/youtube/jobs/${encodeURIComponent(startPayload.jobId)}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as AudioJobPayload;

      if (!response.ok) {
        throw new Error(payload.error || "Open-source audio import failed");
      }

      if (payload.status && payload.status !== lastStatus) {
        lastStatus = payload.status;
        setStatus(payload.status);
        syncYoutubeProgress(payload.status);
      }

      if (payload.state === "failed") {
        throw new Error(payload.error || payload.workerError || "Open-source audio import failed");
      }

      if (payload.state === "completed") {
        if (!payload.transcription?.midiBase64) {
          throw new Error("The audio worker did not return a MIDI file.");
        }

        completeProgressStep("transcribe", "Notes detected");
        completeProgressStep("arrange", "MIDI ready");
        return payload.transcription;
      }
    }

    throw new Error("Audio transcription is still running. Try again from the shared library in a few minutes.");
  }

  async function chooseDirectory(key: DirectoryKey) {
    try {
      const handle = await pickDirectory(key);
      if (!handle) {
        setStatus("Folder picker unavailable");
        return;
      }

      setSettings((current) => ({
        ...current,
        [key === "exportDirectory" ? "exportPathLabel" : "importPathLabel"]: handle.name,
      }));
      setStatus(`${key === "exportDirectory" ? "Export" : "Import"} folder set`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Folder selection canceled");
    }
  }

  async function exportBlob(blob: Blob, filename: string, title: string) {
    try {
      const handle = settings.ioMode === "automatic" ? await getDirectoryHandle("exportDirectory") : null;
      if (handle) {
        await writeMidiFile(handle, filename, blob);
        setStatus(`Saved ${filename}`);
        return true;
      }

      if (settings.ioMode === "manual" && (await shareMidiFile(blob, filename, title))) {
        setStatus(`Choose a folder in Files for ${filename}`);
        return true;
      }

      downloadBlob(blob, filename);
      setStatus(`Downloaded ${filename}`);
      return true;
    } catch (error) {
      if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
        setStatus("Export canceled");
        return false;
      }

      downloadBlob(blob, filename);
      setStatus(error instanceof Error ? `${error.message} Downloaded instead` : "Downloaded instead");
      return true;
    }
  }

  async function scoreBlob(song: SongEntry) {
    if (song.scoreBase64) {
      return base64ToBlob(song.scoreBase64, song.scoreMimeType || "application/pdf");
    }

    const scoreUrl = song.scoreDownloadUrl || song.scoreUrl;
    if (scoreUrl) {
      const response = await fetch(scoreUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Stored score could not be downloaded.");
      }
      return response.blob();
    }

    if (song.musicXml) {
      return new Blob([song.musicXml], { type: "application/vnd.recordare.musicxml+xml" });
    }

    throw new Error("No stored sheet music is available for this song.");
  }

  async function midiBlob(song: SongEntry) {
    if (song.midiBase64) {
      return base64ToBlob(song.midiBase64);
    }

    const midiUrl = song.midiDownloadUrl || song.midiUrl;
    if (midiUrl) {
      const response = await fetch(midiUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Stored MIDI could not be downloaded.");
      }
      return response.blob();
    }

    throw new Error("No stored MIDI is available for this song.");
  }

  async function exportSong(song: SongEntry, kind: ExportKind = "midi") {
    setExportMenuOpenFor("");

    if (kind === "score") {
      try {
        const blob = await scoreBlob(song);
        const filename = song.scoreFilename || `${safeMidiFilename(song.title).replace(/\.mid$/i, "")}.musicxml`;
        await exportBlob(blob, filename, `Export ${song.title} sheet music`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Sheet music export failed");
      }
      return;
    }

    try {
      const blob = await midiBlob(song);
      const filename = song.midiFilename || safeMidiFilename(song.title);

      if (await exportBlob(blob, filename, `Export ${song.title}`)) {
        setSongs((current) =>
          current.map((item) => (item.id === song.id ? { ...item, status: "saved" } : item)),
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MIDI export failed");
    }
  }

  async function addSongFromConversion(
    result: ReturnType<typeof convertMusicXmlToMidi>,
    sourceFile: string,
    musicXml = "",
    scoreAsset: Partial<SongEntry> = {},
  ) {
    const title = formState.title.trim() || result.title;
    fillFormFromResult({ ...result, title });
    const entry: SongEntry = {
      id: crypto.randomUUID(),
      title,
      artist: formState.artist.trim() || result.artist,
      year: formState.year.trim() || result.year || new Date().getFullYear().toString(),
      genre: formState.genre,
      subGenre: formState.subGenre || result.subGenre,
      createdAt: new Date().toISOString(),
      sourceFile,
      youtubeUrl: formState.youtubeUrl.trim(),
      youtubeId: getYouTubeId(formState.youtubeUrl),
      midiBase64: bytesToBase64(result.bytes),
      midiFilename: safeMidiFilename(title),
      durationSeconds: result.durationSeconds,
      noteCount: result.noteCount,
      partCount: result.partCount,
      previewNotes: result.previewNotes,
      waveform: result.waveform,
      musicXml,
      scoreBase64: scoreAsset.scoreBase64,
      scoreFilename: scoreAsset.scoreFilename,
      scoreMimeType: scoreAsset.scoreMimeType,
      engine: "MusicXML",
      quantizer: "score timing",
      arrangement: "Score MIDI",
      status: "ready",
    };

    setSongs((current) => mergeSongs([entry], current));
    setSelectedId(entry.id);
    setStatus("SolvysMIDI ready");

    try {
      await saveSharedSong(entry);
      setStatus("Saved to shared library");
    } catch (error) {
      setStatus(error instanceof Error ? `${error.message}. Saved locally.` : "Saved locally");
    }

    if (settings.ioMode === "automatic") {
      window.setTimeout(() => exportSong(entry), 50);
    }

    return entry;
  }

  async function addSongFromTranscription(
    result: TranscriptionPayload,
    sourceFile: string,
    scoreAsset: Partial<SongEntry> = {},
  ) {
    const title = formState.title.trim() || result.title;
    fillFormFromResult({ ...result, title });
    const entry: SongEntry = {
      id: result.storageId || crypto.randomUUID(),
      title,
      artist: formState.artist.trim() || result.artist,
      year: formState.year.trim() || result.year || new Date().getFullYear().toString(),
      genre: formState.genre || result.genre,
      subGenre: formState.subGenre || result.subGenre,
      createdAt: new Date().toISOString(),
      sourceFile,
      youtubeUrl: formState.youtubeUrl.trim(),
      youtubeId: getYouTubeId(formState.youtubeUrl),
      midiBase64: result.midiBase64,
      midiFilename: result.midiFilename || safeMidiFilename(title),
      durationSeconds: result.durationSeconds,
      noteCount: result.noteCount,
      partCount: result.partCount,
      previewNotes: result.previewNotes,
      waveform: result.waveform,
      musicXml: result.musicXml,
      scoreBase64: scoreAsset.scoreBase64,
      scoreFilename: scoreAsset.scoreFilename,
      scoreMimeType: scoreAsset.scoreMimeType,
      engine: result.engine,
      quantizer: result.quantizer,
      arrangement: result.arrangement,
      arrangementStats: result.arrangementStats,
      warnings: result.warnings,
      status: "ready",
    };

    setSongs((current) => mergeSongs([entry], current));
    setSelectedId(entry.id);
    setPreviewProgress(0);
    setStatus(result.arrangement ? `${title} ready as ${result.arrangement}` : `${title} ready`);

    try {
      await saveSharedSong(entry);
      setStatus(result.arrangement ? `${title} saved to shared library as ${result.arrangement}` : `${title} saved to shared library`);
    } catch (error) {
      setStatus(error instanceof Error ? `${error.message}. Saved locally.` : `${title} saved locally`);
    }

    if (settings.ioMode === "automatic") {
      window.setTimeout(() => exportSong(entry), 50);
    }

    return entry;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isTranscribing) {
      return;
    }

    const file = fileInputRef.current?.files?.[0];
    const hasYouTubeLink = Boolean(getYouTubeId(formState.youtubeUrl));

    if (!file && !hasYouTubeLink) {
      setStatus("Choose a score file or paste a YouTube link");
      return;
    }

    try {
      setIsTranscribing(true);
      if (!file && hasYouTubeLink) {
        startConversionProgress("youtube", "queue");
        setStatus("Starting YouTube transcription");
        const result = await transcribeYoutube();
        activateProgressStep("store", "Saving MIDI and metadata");
        const entry = await addSongFromTranscription(result, result.arrangement || "Playable YouTube arrangement");
        completeProgressStep("store", "Saved");
        activateProgressStep("metadata", "Filling title, artist, year, genre");
        completeProgressStep("metadata", "Song info ready");
        finishProgress("Conversion complete", () => revealCompletedSong(entry.id));
        return;
      }

      if (!file) {
        return;
      }

      startConversionProgress(file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "score", "read");
      setStatus("Reading score");
      const scoreAsset = await scoreAssetFromFile(file);
      completeProgressStep("read", "Score loaded");
      if (file.name.toLowerCase().endsWith(".pdf")) {
        activateProgressStep("upload", "Sending PDF to OMR worker");
        setStatus("Transcribing PDF");
        const result = await transcribePdf(file);
        completeProgressStep("upload", "OMR worker finished");
        activateProgressStep("transcribe", "Reading notation");
        completeProgressStep("transcribe", "Notation detected");
        activateProgressStep("write", "Writing MIDI");
        completeProgressStep("write", "MIDI ready");
        activateProgressStep("store", "Saving MIDI and metadata");
        const entry = await addSongFromTranscription(result, file.name, scoreAsset);
        completeProgressStep("store", "Saved");
        activateProgressStep("metadata", "Filling title, artist, year, genre");
        completeProgressStep("metadata", "Song info ready");
        finishProgress("Conversion complete", () => revealCompletedSong(entry.id));
        return;
      }

      activateProgressStep("parse", "Parsing MusicXML");
      const xml = await readSheetMusicFile(file);
      completeProgressStep("parse", "Notation parsed");
      activateProgressStep("write", "Writing MIDI");
      setStatus("Writing MIDI");
      const result = convertMusicXmlToMidi(xml, file.name);
      completeProgressStep("write", "MIDI ready");
      activateProgressStep("store", "Saving MIDI and metadata");
      const entry = await addSongFromConversion(result, file.name, xml, scoreAsset);
      completeProgressStep("store", "Saved");
      activateProgressStep("metadata", "Filling title, artist, year, genre");
      completeProgressStep("metadata", "Song info ready");
      finishProgress("Conversion complete", () => revealCompletedSong(entry.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcription failed";
      setStatus(message);
      failProgress(message);
    } finally {
      setIsTranscribing(false);
    }
  }

  function deleteLocalData() {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(DELETED_SONGS_KEY);
    setSongs([]);
    setSettings(DEFAULT_SETTINGS);
    setSelectedId("");
    setStatus("Local data deleted");
  }

  function deleteSong(song: SongEntry) {
    if (previewSongId === song.id) {
      stopPreview();
    }

    setExportMenuOpenFor("");
    setSwipedSongId("");
    setSwipingSongId("");
    setSwipeOffset(0);
    rememberDeletedSong(song.id);
    setSongs((current) => {
      const remaining = current.filter((item) => item.id !== song.id);
      if (selectedId === song.id) {
        setSelectedId(remaining[0]?.id ?? "");
      }
      return remaining;
    });
    setStatus(`${song.title} deleted locally`);
  }

  function handleSongPointerDown(event: PointerEvent<HTMLButtonElement>, songId: string) {
    swipeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offset: swipedSongId === songId ? -88 : 0,
      axis: "",
      moved: false,
    };
    setSwipingSongId(songId);
    setSwipeOffset(swipedSongId === songId ? -88 : 0);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic mobile tests may not have an active browser pointer to capture.
    }
  }

  function handleSongPointerMove(event: PointerEvent<HTMLButtonElement>, songId: string) {
    const swipe = swipeRef.current;
    if (swipe.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - swipe.startX;
    const deltaY = event.clientY - swipe.startY;
    if (!swipe.axis && Math.max(Math.abs(deltaX), Math.abs(deltaY)) > 8) {
      swipe.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
    }

    if (swipe.axis !== "x") {
      return;
    }

    event.preventDefault();
    swipe.moved = true;
    const baseOffset = swipedSongId === songId ? -88 : 0;
    const nextOffset = Math.min(0, Math.max(-104, baseOffset + deltaX));
    swipe.offset = nextOffset;
    setSwipeOffset(nextOffset);
  }

  function finishSongSwipe(event: PointerEvent<HTMLButtonElement>, songId: string) {
    const swipe = swipeRef.current;
    if (swipe.pointerId !== event.pointerId) {
      return;
    }

    if (swipe.axis === "x" && swipe.moved) {
      setSwipedSongId(swipe.offset < -44 ? songId : "");
    }

    setSwipingSongId("");
    setSwipeOffset(0);
    swipeRef.current = { pointerId: -1, startX: 0, startY: 0, offset: 0, axis: "", moved: false };
  }

  function selectSong(songId: string) {
    if (swipeRef.current.moved) {
      return;
    }

    if (swipedSongId) {
      setSwipedSongId("");
      return;
    }

    setSelectedId(songId);
  }

  function setTab(tab: TabId) {
    setActiveTab(tab);
    setDrawerOpen(false);
    setExportMenuOpenFor("");
  }

  const selectedIsPlaying = Boolean(selectedSong && isPlaying && previewSongId === selectedSong.id);
  const selectedWaveform = selectedSong?.waveform?.length ? selectedSong.waveform : [];
  const selectedHasYoutube = Boolean(selectedSong && getYouTubeId(selectedSong.youtubeUrl || selectedSong.youtubeId));
  const selectedPreviewDuration = selectedSong
    ? selectedHasYoutube
      ? Math.min(30, Math.max(selectedSong.durationSeconds || 30, 1))
      : selectedSong.durationSeconds || 0
    : 0;
  const waveformProgressIndex = Math.floor(previewProgress * selectedWaveform.length);
  const activeTitle = activeTab === "songs" ? "Songs" : activeTab === "new" ? "New" : "Settings";
  const selectedYouTubeUrl = selectedSong?.youtubeUrl || (selectedSong?.youtubeId ? `https://www.youtube.com/watch?v=${selectedSong.youtubeId}` : "");
  const selectedYoutubeAudioUrl = selectedSong && youtubePreviewSongId === selectedSong.id ? youtubeAutoplayUrl(selectedSong) : "";
  const selectedHasScore = Boolean(selectedSong?.scoreBase64 || selectedSong?.scoreUrl || selectedSong?.scoreDownloadUrl || selectedSong?.musicXml);
  const selectedScoreLabel =
    selectedSong?.scoreMimeType?.includes("pdf") || selectedSong?.scoreFilename?.toLowerCase().endsWith(".pdf")
      ? "PDF"
      : "Score";

  return (
    <main className="pwaShell">
      <section className="phoneFrame" aria-label="SolvysMIDI sheet music to MIDI">
        <nav className={drawerOpen ? "bottomDrawer bottomDrawerOpen" : "bottomDrawer"} aria-label="Primary tabs">
          <button className={activeTab === "songs" ? "drawerTab drawerTabActive" : "drawerTab"} onClick={() => setTab("songs")} type="button">
            <Library size={19} />
            Songs
          </button>
          <button className={activeTab === "new" ? "drawerTab drawerTabActive" : "drawerTab"} onClick={() => setTab("new")} type="button">
            <Plus size={21} />
            New
          </button>
          <button className={activeTab === "settings" ? "drawerTab drawerTabActive" : "drawerTab"} onClick={() => setTab("settings")} type="button">
            <Settings size={19} />
            Settings
          </button>
        </nav>

        <div className="screenBody">
          <span className="srOnly" aria-live="polite">{status}</span>
          {activeTab === "songs" && (
            <div className={selectedSong ? "songsView" : "songsView songsViewEmpty"}>
              {selectedSong ? (
                <>
                  <div className="songsDetail">
                    <section className="songHero">
                      <div className="songHeroMeta">
                        <div className="songTitleRow">
                          <h2>{selectedSong.title}</h2>
                          {selectedSong.youtubeId ? (
                            <a
                              className="titleYouTubeButton"
                              href={selectedYouTubeUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open ${selectedSong.title} on YouTube`}
                            >
                              <Play size={18} fill="currentColor" />
                            </a>
                          ) : null}
                        </div>
                        <p>{selectedSong.artist}</p>
                        <span>
                          {selectedSong.genre} · {selectedSong.subGenre} · {selectedSong.year || "Year"}
                        </span>
                      </div>
                      <div className="heroActions">
                        <button className="roundAction selected" type="button" aria-label="Converted">
                          <Check size={22} />
                        </button>
                        <span className="exportAction">
                          <button
                            className="roundAction"
                            type="button"
                            onClick={() =>
                              setExportMenuOpenFor((openFor) => (openFor === selectedSong.id ? "" : selectedSong.id))
                            }
                            aria-label="Download"
                            aria-expanded={exportMenuOpenFor === selectedSong.id}
                          >
                            <Download size={22} />
                          </button>
                          {exportMenuOpenFor === selectedSong.id ? (
                            <span className="exportPopover" role="menu" aria-label="Download format">
                              <button type="button" role="menuitem" onClick={() => exportSong(selectedSong, "midi")}>
                                MIDI
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => exportSong(selectedSong, "score")}
                                disabled={!selectedHasScore}
                              >
                                {selectedScoreLabel}
                              </button>
                            </span>
                          ) : null}
                        </span>
                        <button className="roundAction" type="button" onClick={() => exportSong(selectedSong)} aria-label="Save MIDI to Files">
                          <FolderOpen size={21} />
                        </button>
                        <button className="playAction" type="button" onClick={() => togglePreview(selectedSong)} aria-label={selectedHasYoutube ? "Play YouTube audio preview" : "Play MIDI preview"}>
                          {selectedIsPlaying ? <Pause size={34} /> : <Play size={34} />}
                        </button>
                      </div>
                    </section>

                    {selectedWaveform.length > 0 && (
                      <section className="waveformCard" aria-label="Audio preview">
                        <button type="button" onClick={() => togglePreview(selectedSong)}>
                          {selectedIsPlaying ? <Pause size={18} /> : <Play size={18} />}
                          {selectedHasYoutube ? "YouTube preview" : "Audio preview"}
                        </button>
                        <div className="waveformBars" data-testid="waveform-bars">
                          {selectedWaveform.map((bar, index) => (
                            <span
                              className={index <= waveformProgressIndex && selectedIsPlaying ? "waveformBar waveformBarActive" : "waveformBar"}
                              style={{ height: `${Math.max(14, bar * 44)}px` }}
                              key={`${bar}-${index}`}
                            />
                          ))}
                        </div>
                        <span className="waveformTime">
                          {formatDuration(previewProgress * selectedPreviewDuration)} / {formatDuration(selectedPreviewDuration)}
                        </span>
                        {selectedYoutubeAudioUrl ? (
                          <iframe
                            className="youtubeAudioFrame"
                            data-testid="youtube-audio-frame"
                            src={selectedYoutubeAudioUrl}
                            title={`${selectedSong.title} YouTube audio preview`}
                            allow="autoplay; encrypted-media; picture-in-picture; web-share"
                          />
                        ) : null}
                      </section>
                    )}

                  </div>

                  <div className="songsIndex">
                    <section className="sortPanel" aria-label="Sort songs">
                      <div className="sortTitle">
                        <ListFilter size={17} />
                        <span>Sort</span>
                      </div>
                      <div className="sortScroller">
                        <SortButton label="Recent" value="recent" active={sortKey} onClick={setSortKey} />
                        <SortButton label="Artist" value="artist" active={sortKey} onClick={setSortKey} />
                        <SortButton label="Year" value="year" active={sortKey} onClick={setSortKey} />
                        <SortButton label="Genre" value="genre" active={sortKey} onClick={setSortKey} />
                        <SortButton label="Sub-genre" value="subGenre" active={sortKey} onClick={setSortKey} />
                      </div>
                    </section>

                    <section className="songList" aria-label="Transcription history">
                      {sortedSongs.map((song) => (
                        <span
                          className={[
                            "songSwipeItem",
                            swipingSongId === song.id || swipedSongId === song.id ? "songSwipeItemRevealing" : "",
                            swipedSongId === song.id ? "songSwipeItemOpen" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          key={song.id}
                        >
                          <button className="songDeleteAction" type="button" onClick={() => deleteSong(song)} aria-label={`Delete ${song.title}`}>
                            <Trash2 size={21} />
                            Delete
                          </button>
                          <button
                            className={song.id === selectedSong?.id ? "songRow songRowActive" : "songRow"}
                            style={{
                              transform: `translateX(${
                                swipingSongId === song.id ? swipeOffset : swipedSongId === song.id ? -88 : 0
                              }px)`,
                            }}
                            type="button"
                            onClick={() => selectSong(song.id)}
                            onPointerDown={(event) => handleSongPointerDown(event, song.id)}
                            onPointerMove={(event) => handleSongPointerMove(event, song.id)}
                            onPointerUp={(event) => finishSongSwipe(event, song.id)}
                            onPointerCancel={(event) => finishSongSwipe(event, song.id)}
                          >
                            <SongArtwork song={song} />
                            <span className="rowText">
                              <strong>{song.title}</strong>
                              <small>{song.artist}</small>
                              <SongRowWaveform
                                waveform={song.waveform ?? []}
                                active={selectedIsPlaying && song.id === selectedSong?.id}
                                progressIndex={song.id === selectedSong?.id ? waveformProgressIndex : -1}
                              />
                            </span>
                            <span className={`statusDot status-${song.status}`}>{song.status}</span>
                            <MoreHorizontal size={20} />
                          </button>
                        </span>
                      ))}
                    </section>
                  </div>

                </>
              ) : (
                <section className="emptyState">
                  <Music2 size={28} />
                  <h2>No songs</h2>
                </section>
              )}
            </div>
          )}

          {activeTab === "new" && (
            <form className="newPanel" onSubmit={handleSubmit}>
              <label className="fileDrop">
                <Upload size={27} />
                <span>{fileName || "PDF, MusicXML, XML, or MXL"}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".musicxml,.xml,.mxl,.pdf,.png,.jpg,.jpeg"
                  onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
                />
              </label>

              <div className="formGrid formGridSingle">
                <label className="wideField">
                  YouTube link
                  <input
                    data-testid="youtube-url-input"
                    value={formState.youtubeUrl}
                    onChange={(event) => updateForm("youtubeUrl", event.target.value)}
                    placeholder="youtube.com/watch?v=..."
                  />
                </label>
              </div>

              <div className="buttonRow">
                <button className="primaryButton" data-testid="transcribe-submit" type="submit" disabled={isTranscribing}>
                  {isTranscribing ? <span className="primaryButtonSpinner" aria-hidden="true" /> : <Music2 size={19} />}
                  {isTranscribing ? "Transcribing" : "Transcribe"}
                </button>
              </div>
              <ConversionProgressPanel steps={conversionSteps} visible={conversionProgressVisible} />
              {status ? <p className="formStatus" aria-live="polite">{status}</p> : null}
            </form>
          )}

          {activeTab === "settings" && (
            <section className="settingsPanel">
              <div className="settingRow">
                <div>
                  <strong>Theme</strong>
                  <span>{settings.theme === "dark" ? "Dark" : "Khaki"}</span>
                </div>
                <div className="segmented">
                  <button className={settings.theme === "dark" ? "active" : ""} onClick={() => setSettings((current) => ({ ...current, theme: "dark" }))} type="button">
                    Dark
                  </button>
                  <button className={settings.theme === "khaki" ? "active" : ""} onClick={() => setSettings((current) => ({ ...current, theme: "khaki" }))} type="button">
                    Light
                  </button>
                </div>
              </div>

              <div className="settingRow">
                <div>
                  <strong>Export filepath</strong>
                  <span>{settings.exportPathLabel}</span>
                </div>
                <button className="settingsButton" type="button" onClick={() => chooseDirectory("exportDirectory")}>
                  <FolderOpen size={18} />
                  Choose
                </button>
              </div>

              <div className="settingRow">
                <div>
                  <strong>Import filepath</strong>
                  <span>{settings.importPathLabel}</span>
                </div>
                <button className="settingsButton" type="button" onClick={() => chooseDirectory("importDirectory")}>
                  <FolderOpen size={18} />
                  Choose
                </button>
              </div>

              <div className="settingRow">
                <div>
                  <strong>I/O</strong>
                  <span>{settings.ioMode}</span>
                </div>
                <div className="segmented">
                  <button className={settings.ioMode === "automatic" ? "active" : ""} onClick={() => setSettings((current) => ({ ...current, ioMode: "automatic" }))} type="button">
                    Auto
                  </button>
                  <button className={settings.ioMode === "manual" ? "active" : ""} onClick={() => setSettings((current) => ({ ...current, ioMode: "manual" }))} type="button">
                    Manual
                  </button>
                </div>
              </div>

              <button className="deleteButton" type="button" onClick={deleteLocalData}>
                <Trash2 size={19} />
                Delete local data
              </button>
            </section>
          )}
        </div>

        <footer className={drawerOpen ? "bottomBar bottomBarDrawerOpen" : "bottomBar"}>
          <button className="iconButton" type="button" onClick={() => setDrawerOpen((open) => !open)} aria-label="Open tabs">
            <ChevronDown className={drawerOpen ? "chevronOpen" : ""} size={25} />
          </button>
          <div className="bottomBarTitle">
            <h1>{activeTitle}</h1>
          </div>
          <div className="footerStatusRail" aria-label="System status">
            <FooterStatus label="API" status={health.api} />
            <FooterStatus label="Audio" status={health.audio} />
            <FooterStatus label="Backend" status={health.backend} />
          </div>
        </footer>
      </section>
    </main>
  );
}
