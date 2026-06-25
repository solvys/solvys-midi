import base64
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import mido


PORT = int(os.environ.get("PORT", "8080"))
TIMEOUT_SECONDS = int(os.environ.get("AUDIO_TIMEOUT_SECONDS", "900"))
TRANSKUN_DEVICE = os.environ.get("TRANSKUN_DEVICE", "cpu")
AUDIO_ENGINE_MODE = os.environ.get("AUDIO_ENGINE_MODE", "transkun").lower()
BASIC_PITCH_MODE = os.environ.get("BASIC_PITCH_MODE", "fallback").lower()
QUANTIZE_DIVISIONS = max(1, int(os.environ.get("QUANTIZE_DIVISIONS", "4")))
YTDLP_FORMAT = os.environ.get("YTDLP_FORMAT", "bestaudio/best")
YTDLP_EXTRACTOR_ARGS = os.environ.get(
    "YTDLP_EXTRACTOR_ARGS",
    "youtube:player_client=default,android,ios;formats=missing_pot",
)
YTDLP_JS_RUNTIME = os.environ.get("YTDLP_JS_RUNTIME", "deno").strip()
YTDLP_FORCE_IPV4 = os.environ.get("YTDLP_FORCE_IPV4", "1").strip() != "0"
TRANSKUN_SEGMENT_HOP_SIZE = os.environ.get("TRANSKUN_SEGMENT_HOP_SIZE", "").strip()
TRANSKUN_SEGMENT_SIZE = os.environ.get("TRANSKUN_SEGMENT_SIZE", "").strip()
ARRANGE_MAX_NOTES_PER_SLICE = max(2, int(os.environ.get("ARRANGE_MAX_NOTES_PER_SLICE", "6")))
ARRANGE_MAX_RIGHT_HAND = max(1, int(os.environ.get("ARRANGE_MAX_RIGHT_HAND", "4")))
ARRANGE_MAX_LEFT_HAND = max(1, int(os.environ.get("ARRANGE_MAX_LEFT_HAND", "3")))
ARRANGE_HAND_SPLIT = int(os.environ.get("ARRANGE_HAND_SPLIT_MIDI", "60"))
PIANO_LOW = 21
PIANO_HIGH = 108
JOB_TTL_SECONDS = int(os.environ.get("JOB_TTL_SECONDS", "7200"))
JOB_STORE_DIR = os.environ.get("JOB_STORE_DIR", "").strip()
MAX_ACTIVE_JOBS = max(1, int(os.environ.get("MAX_ACTIVE_JOBS", "2")))
MAX_REQUEST_BYTES = max(1024, int(os.environ.get("MAX_REQUEST_BYTES", "16384")))
REQUIRE_WORKER_TOKEN = os.environ.get("REQUIRE_WORKER_TOKEN", "0").strip() == "1"
JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$")
ALLOWED_EXECUTABLES = {"basic-pitch", "ffmpeg", "ffprobe", "transkun", "yt-dlp"}
JOBS = {}
JOBS_LOCK = threading.Lock()


def send_json(handler, status, payload):
    encoded = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(encoded)))
    handler.end_headers()
    handler.wfile.write(encoded)


def bearer_authorized(headers):
    token = os.environ.get("AUDIO_TRANSCRIPTION_WORKER_TOKEN", "").strip()
    if not token:
        return not REQUIRE_WORKER_TOKEN
    return headers.get("authorization") == f"Bearer {token}"


def clean(value):
    return value.strip() if isinstance(value, str) else ""


def job_time():
    return int(time.time())


def sanitize_request(payload):
    return {
        "youtubeUrl": clean(payload.get("youtubeUrl")),
        "title": clean(payload.get("title")),
        "artist": clean(payload.get("artist")),
        "year": clean(payload.get("year")),
        "genre": clean(payload.get("genre")),
        "subGenre": clean(payload.get("subGenre")),
    }


def cleanup_jobs_locked():
    cutoff = job_time() - JOB_TTL_SECONDS
    stale_ids = [
        job_id
        for job_id, job in JOBS.items()
        if int(job.get("updatedAt") or job.get("createdAt") or 0) < cutoff
    ]
    for job_id in stale_ids:
        JOBS.pop(job_id, None)
        delete_job_file(job_id)


def checked_job_id(job_id):
    value = clean(job_id)
    if not JOB_ID_RE.fullmatch(value):
        raise ValueError("Invalid audio job ID.")
    return value


def job_store_path(job_id):
    if not JOB_STORE_DIR:
        return None
    directory = pathlib.Path(JOB_STORE_DIR).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    path = (directory / f"{checked_job_id(job_id)}.json").resolve()
    path.relative_to(directory)
    return path


def persist_job(job):
    path = job_store_path(job["id"])
    if not path:
        return
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.stem}-", suffix=".tmp", delete=False) as handle:
        handle.write(json.dumps(job))
        temp_path = pathlib.Path(handle.name).resolve()
    temp_path.relative_to(path.parent)
    os.replace(temp_path, path)


def delete_job_file(job_id):
    path = job_store_path(job_id)
    if not path:
        return
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass


def load_jobs_from_store():
    if not JOB_STORE_DIR:
        return
    directory = pathlib.Path(JOB_STORE_DIR)
    if not directory.exists():
        return
    loaded = 0
    with JOBS_LOCK:
        for path in directory.glob("*.json"):
            try:
                job = json.loads(path.read_text(encoding="utf-8"))
                try:
                    job_id = checked_job_id(job.get("id"))
                except ValueError:
                    continue
                if job.get("state") in {"queued", "running"}:
                    job["state"] = "failed"
                    job["status"] = "Worker restarted"
                    job["error"] = "The audio worker restarted before this transcription finished. Please start a new transcription."
                    job["updatedAt"] = job_time()
                    persist_job(job)
                JOBS[job_id] = job
                loaded += 1
            except Exception as error:
                print(f"Could not load job record {path}: {error}", flush=True)
        cleanup_jobs_locked()
    if loaded:
        print(f"Loaded {loaded} persisted audio jobs", flush=True)


def active_jobs_locked():
    return sum(1 for job in JOBS.values() if job.get("state") in {"queued", "running"})


def public_job(job):
    payload = {
        "jobId": job["id"],
        "state": job["state"],
        "status": job["status"],
        "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"],
        "request": job.get("request", {}),
    }
    if job["state"] == "completed":
        payload["result"] = job.get("result")
    if job["state"] == "failed":
        payload["error"] = job.get("error") or "Audio transcription failed."
    return payload


def update_job(job_id, **updates):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        job["updatedAt"] = job_time()
        persist_job(job)


def run_job(job_id, payload):
    try:
        update_job(job_id, state="running", status="Starting audio import")
        result = transcribe(payload, lambda status: update_job(job_id, state="running", status=status))
        update_job(job_id, state="completed", status="MIDI ready", result=result)
    except subprocess.TimeoutExpired:
        update_job(job_id, state="failed", status="Timed out", error="Audio transcription timed out.")
    except Exception as error:
        update_job(job_id, state="failed", status="Failed", error=str(error))


def require_youtube_url(url):
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http/https YouTube links are accepted.")
    if host not in {"youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"} and not host.endswith(".youtube.com"):
        raise ValueError("Only YouTube links are accepted.")


def resolve_executable(command_name):
    if command_name not in ALLOWED_EXECUTABLES:
        raise ValueError("Unsupported worker executable.")
    executable = shutil.which(command_name)
    if not executable:
        raise RuntimeError(f"{command_name} is not installed in the audio worker.")
    return executable


def run_command(command_name, arguments, cwd):
    command = [resolve_executable(command_name), *[str(argument) for argument in arguments]]
    result = subprocess.run(
        command,
        cwd=str(pathlib.Path(cwd).resolve()),
        shell=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "Command failed.").strip()
        raise RuntimeError(message[-2000:])
    return result


def normalize_audio(audio_path, work_dir):
    output_path = pathlib.Path(work_dir) / "analysis-mono-44100.wav"
    run_command(
        "ffmpeg",
        [
            "-y",
            "-i",
            str(audio_path),
            "-ac",
            "1",
            "-ar",
            "44100",
            str(output_path),
        ],
        work_dir,
    )
    if not output_path.exists():
        raise RuntimeError("ffmpeg did not produce a normalized analysis WAV file.")
    return output_path


def probe_audio_duration(audio_path, work_dir):
    result = run_command(
        "ffprobe",
        [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(audio_path),
        ],
        work_dir,
    )
    try:
        return max(0.0, float((result.stdout or "").strip()))
    except ValueError:
        return 0.0


def download_youtube_audio(url, work_dir):
    template = str(pathlib.Path(work_dir) / "source.%(ext)s")
    arguments = [
        "--no-update",
        "--no-playlist",
        "--format",
        YTDLP_FORMAT,
        "--extract-audio",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--concurrent-fragments",
        "1",
        "-o",
        template,
        url,
    ]
    if YTDLP_FORCE_IPV4:
        arguments.insert(0, "--force-ipv4")
    if YTDLP_EXTRACTOR_ARGS:
        arguments[0:0] = ["--extractor-args", YTDLP_EXTRACTOR_ARGS]
    if YTDLP_JS_RUNTIME:
        arguments[0:0] = ["--js-runtimes", YTDLP_JS_RUNTIME]
    cookies_file = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
    if cookies_file:
        arguments[0:0] = ["--cookies", cookies_file]
    run_command("yt-dlp", arguments, work_dir)
    wav_files = sorted(pathlib.Path(work_dir).glob("source*.wav"))
    if not wav_files:
        raise RuntimeError("yt-dlp did not produce a WAV file.")
    return wav_files[0]


def run_transkun(audio_path, work_dir):
    out_path = pathlib.Path(work_dir) / "transkun.mid"
    arguments = [str(audio_path), str(out_path), "--device", TRANSKUN_DEVICE]
    if TRANSKUN_SEGMENT_HOP_SIZE:
        arguments.extend(["--segmentHopSize", TRANSKUN_SEGMENT_HOP_SIZE])
    if TRANSKUN_SEGMENT_SIZE:
        arguments.extend(["--segmentSize", TRANSKUN_SEGMENT_SIZE])
    run_command("transkun", arguments, work_dir)
    if not out_path.exists():
        raise RuntimeError("Transkun finished without producing MIDI.")
    return out_path


def run_basic_pitch(audio_path, work_dir):
    if BASIC_PITCH_MODE == "off":
        return None
    out_dir = pathlib.Path(work_dir) / "basic-pitch"
    out_dir.mkdir(parents=True, exist_ok=True)
    run_command("basic-pitch", [str(out_dir), str(audio_path)], work_dir)
    midi_files = sorted(out_dir.glob("*.mid"))
    return midi_files[0] if midi_files else None


def is_note_on(message):
    return message.type == "note_on" and message.velocity > 0


def is_note_end(message):
    return message.type == "note_off" or (message.type == "note_on" and message.velocity == 0)


def event_rank(message):
    if is_note_end(message):
        return 0
    if message.is_meta:
        return 1
    if is_note_on(message):
        return 2
    return 3


def quantize_value(value, grid):
    return int(round(value / grid) * grid)


def quantize_midi(input_path, output_path):
    midi = mido.MidiFile(input_path)
    grid = max(1, int(round(midi.ticks_per_beat / QUANTIZE_DIVISIONS)))
    min_duration = max(1, int(round(grid / 2)))
    quantized = mido.MidiFile(type=midi.type, ticks_per_beat=midi.ticks_per_beat)
    note_count = 0

    for track in midi.tracks:
        absolute = 0
        events = []
        active = {}
        for order, message in enumerate(track):
            absolute += message.time
            next_absolute = absolute
            copied = message.copy(time=0)
            if is_note_on(copied):
                next_absolute = max(0, quantize_value(absolute, grid))
                active.setdefault((copied.channel, copied.note), []).append(next_absolute)
                note_count += 1
            elif is_note_end(copied):
                stack = active.get((copied.channel, copied.note), [])
                start = stack.pop() if stack else None
                next_absolute = max(0, quantize_value(absolute, grid))
                if start is not None:
                    next_absolute = max(start + min_duration, next_absolute)
            events.append((next_absolute, order, copied))

        events.sort(key=lambda item: (item[0], event_rank(item[2]), item[1]))
        new_track = mido.MidiTrack()
        previous = 0
        for absolute_time, _order, message in events:
            absolute_time = max(previous, int(absolute_time))
            message.time = absolute_time - previous
            new_track.append(message)
            previous = absolute_time
        quantized.tracks.append(new_track)

    if note_count == 0:
        raise RuntimeError("The transcription MIDI did not contain playable notes.")

    quantized.save(output_path)
    return note_count


def collect_note_events(midi):
    notes = []
    meta_events = []

    for track in midi.tracks:
        absolute = 0
        active = {}
        for message in track:
            absolute += message.time
            if message.is_meta:
                if message.type in {"set_tempo", "time_signature", "key_signature"}:
                    meta_events.append((absolute, message.copy(time=0)))
                continue

            if not hasattr(message, "note"):
                continue

            channel = getattr(message, "channel", 0)
            key = (channel, message.note)
            if is_note_on(message):
                active.setdefault(key, []).append((absolute, message.velocity))
            elif is_note_end(message):
                stack = active.get(key, [])
                if not stack:
                    continue
                start, velocity = stack.pop(0)
                end = max(start + 1, absolute)
                if PIANO_LOW <= message.note <= PIANO_HIGH:
                    notes.append({
                        "start": start,
                        "end": end,
                        "pitch": message.note,
                        "velocity": max(1, int(velocity or 72)),
                    })

    return notes, meta_events


def note_score(note):
    duration = max(1, note["end"] - note["start"])
    edge_bonus = 1.25 if note["pitch"] <= 48 or note["pitch"] >= 72 else 1
    return duration * max(1, note["velocity"]) * edge_bonus


def dedupe_start_group(notes):
    by_pitch = {}
    for note in notes:
        current = by_pitch.get(note["pitch"])
        if not current or note_score(note) > note_score(current):
            by_pitch[note["pitch"]] = note
    return list(by_pitch.values())


def thin_start_group(notes, max_notes):
    group = dedupe_start_group(notes)
    if len(group) <= max_notes:
        return group

    by_pitch = sorted(group, key=lambda item: item["pitch"])
    selected = [by_pitch[0], by_pitch[-1]]
    seen = {id(selected[0]), id(selected[1])}
    candidates = sorted(group, key=note_score, reverse=True)
    for note in candidates:
        if id(note) in seen:
            continue
        selected.append(note)
        seen.add(id(note))
        if len(selected) >= max_notes:
            break

    return sorted(selected, key=lambda item: item["pitch"])


def thin_by_start(notes, max_notes):
    grouped = {}
    for note in notes:
        grouped.setdefault(note["start"], []).append(note)

    thinned = []
    for start in sorted(grouped):
        thinned.extend(thin_start_group(grouped[start], max_notes))
    return thinned


def quantize_notes(notes, ticks_per_beat):
    grid = max(1, int(round(ticks_per_beat / QUANTIZE_DIVISIONS)))
    min_duration = max(1, int(round(grid / 2)))
    quantized = []

    for note in notes:
        start = max(0, quantize_value(note["start"], grid))
        end = max(start + min_duration, quantize_value(note["end"], grid))
        quantized.append({
            **note,
            "start": start,
            "end": end,
        })

    return quantized


def split_hands(notes):
    left = []
    right = []
    for note in notes:
        if note["pitch"] < ARRANGE_HAND_SPLIT:
            left.append(note)
        else:
            right.append(note)

    return (
        thin_by_start(left, ARRANGE_MAX_LEFT_HAND),
        thin_by_start(right, ARRANGE_MAX_RIGHT_HAND),
    )


def copy_meta_track(source_midi):
    meta_track = mido.MidiTrack()
    meta_events = collect_note_events(source_midi)[1]
    if not any(message.type == "set_tempo" for _absolute, message in meta_events):
        meta_events.insert(0, (0, mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(96), time=0)))

    previous = 0
    used = set()
    for absolute, message in sorted(meta_events, key=lambda item: item[0]):
        key = (message.type, absolute)
        if key in used:
            continue
        used.add(key)
        absolute = max(previous, int(absolute))
        copied = message.copy(time=absolute - previous)
        meta_track.append(copied)
        previous = absolute
    meta_track.append(mido.MetaMessage("end_of_track", time=0))
    return meta_track


def note_track(name, notes, channel):
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name=name, time=0))
    events = []
    for note in notes:
        velocity = max(1, min(127, int(note["velocity"])))
        events.append((note["start"], 1, mido.Message("note_on", note=note["pitch"], velocity=velocity, channel=channel, time=0)))
        events.append((note["end"], 0, mido.Message("note_off", note=note["pitch"], velocity=0, channel=channel, time=0)))

    events.sort(key=lambda item: (item[0], item[1], item[2].note))
    previous = 0
    for absolute, _rank, message in events:
        absolute = max(previous, int(absolute))
        message.time = absolute - previous
        track.append(message)
        previous = absolute
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def first_tempo(source_midi):
    for track in source_midi.tracks:
        for message in track:
            if message.is_meta and message.type == "set_tempo":
                return message.tempo
    return mido.bpm2tempo(96)


def extend_track_end(track, target_end_tick):
    if target_end_tick <= 0:
        return

    absolute = 0
    end_index = None
    for index, message in enumerate(track):
        absolute += message.time
        if message.is_meta and message.type == "end_of_track":
            end_index = index

    if end_index is None:
        track.append(mido.MetaMessage("end_of_track", time=max(0, target_end_tick - absolute)))
        return

    end_message = track[end_index]
    existing_end = absolute
    if existing_end >= target_end_tick:
        return

    end_message.time += target_end_tick - existing_end


def duration_marker_track(target_end_tick):
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name="Timeline", time=0))
    if target_end_tick > 1:
        track.append(mido.Message("note_on", note=PIANO_LOW, velocity=1, channel=15, time=target_end_tick - 1))
        track.append(mido.Message("note_off", note=PIANO_LOW, velocity=0, channel=15, time=1))
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def arrange_playable_piano(input_path, output_path, source_duration_seconds=0.0):
    source = mido.MidiFile(input_path)
    raw_notes, _meta = collect_note_events(source)
    if not raw_notes:
        raise RuntimeError("The transcription MIDI did not contain playable notes.")

    quantized = quantize_notes(raw_notes, source.ticks_per_beat)
    thinned = thin_by_start(quantized, ARRANGE_MAX_NOTES_PER_SLICE)
    left, right = split_hands(thinned)

    arranged = mido.MidiFile(type=1, ticks_per_beat=source.ticks_per_beat)
    arranged.tracks.append(copy_meta_track(source))
    arranged.tracks.append(note_track("Left Hand", left, 0))
    arranged.tracks.append(note_track("Right Hand", right, 1))
    if source_duration_seconds:
        target_end_tick = int(mido.second2tick(source_duration_seconds, source.ticks_per_beat, first_tempo(source)))
        for track in arranged.tracks:
            extend_track_end(track, target_end_tick)
        arranged.tracks.append(duration_marker_track(target_end_tick))
    arranged.save(output_path)

    return {
        "inputNotes": len(raw_notes),
        "arrangedNotes": len(left) + len(right),
        "leftHandNotes": len(left),
        "rightHandNotes": len(right),
        "maxNotesPerSlice": ARRANGE_MAX_NOTES_PER_SLICE,
    }


def transcribe(payload, update_status=None):
    youtube_url = clean(payload.get("youtubeUrl"))
    require_youtube_url(youtube_url)
    warnings = []

    with tempfile.TemporaryDirectory(prefix="solvys-midi-audio-") as work_dir:
        if update_status:
            update_status("Downloading YouTube audio")
        source_audio_path = download_youtube_audio(youtube_url, work_dir)
        source_duration_seconds = probe_audio_duration(source_audio_path, work_dir)
        if update_status:
            update_status("Preparing analysis audio")
        audio_path = normalize_audio(source_audio_path, work_dir)
        basic_pitch_midi = None
        source_midi = None
        engine = "Transkun"

        if AUDIO_ENGINE_MODE == "basic-pitch":
            if update_status:
                update_status("Running Basic Pitch transcription")
            source_midi = run_basic_pitch(audio_path, work_dir)
            if not source_midi:
                raise RuntimeError("Basic Pitch finished without producing MIDI.")
            engine = "Basic Pitch"

        if source_midi is None and BASIC_PITCH_MODE == "assist":
            try:
                if update_status:
                    update_status("Running Basic Pitch assist")
                basic_pitch_midi = run_basic_pitch(audio_path, work_dir)
            except Exception as error:
                warnings.append(f"Basic Pitch assist unavailable: {error}")

        if source_midi is None:
            try:
                if update_status:
                    update_status("Running Transkun transcription")
                source_midi = run_transkun(audio_path, work_dir)
            except Exception as error:
                if BASIC_PITCH_MODE == "fallback":
                    try:
                        if update_status:
                            update_status("Running Basic Pitch fallback")
                        basic_pitch_midi = run_basic_pitch(audio_path, work_dir)
                    except Exception as fallback_error:
                        warnings.append(f"Basic Pitch fallback unavailable: {fallback_error}")
                if not basic_pitch_midi:
                    raise
                warnings.append(f"Transkun unavailable; using Basic Pitch fallback: {error}")
                source_midi = basic_pitch_midi
                engine = "Basic Pitch fallback"

        if update_status:
            update_status("Arranging playable piano MIDI")
        arranged_path = pathlib.Path(work_dir) / "playable-piano.mid"
        arrangement = arrange_playable_piano(source_midi, arranged_path, source_duration_seconds)
        midi_bytes = arranged_path.read_bytes()

    return {
        "engine": engine,
        "quantizer": "grid",
        "arrangement": "Playable two-hand piano",
        "arrangementStats": arrangement,
        "audioDurationSeconds": source_duration_seconds,
        "midiBase64": base64.b64encode(midi_bytes).decode("ascii"),
        "warnings": warnings,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            send_json(self, 200, {
                "ok": True,
                "engine": "Basic Pitch" if AUDIO_ENGINE_MODE == "basic-pitch" else "Transkun",
                "engineMode": AUDIO_ENGINE_MODE,
                "quantizer": "grid",
                "arrangement": "Playable two-hand piano",
                "basicPitchMode": BASIC_PITCH_MODE,
            })
            return

        if parsed.path.startswith("/jobs/"):
            if not bearer_authorized(self.headers):
                send_json(self, 401, {"error": "Unauthorized audio worker request."})
                return
            job_id = parsed.path.split("/", 2)[2].strip()
            with JOBS_LOCK:
                cleanup_jobs_locked()
                job = JOBS.get(job_id)
                if not job:
                    send_json(self, 404, {"error": "Audio transcription job was not found."})
                    return
                send_json(self, 200, public_job(job))
                return

        send_json(self, 404, {"error": "Not found."})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in {"/transcribe", "/jobs"}:
            send_json(self, 404, {"error": "Not found."})
            return
        if not bearer_authorized(self.headers):
            send_json(self, 401, {"error": "Unauthorized audio worker request."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                send_json(self, 413, {"error": "Audio worker request payload is too large."})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))

            if parsed.path == "/jobs":
                require_youtube_url(clean(payload.get("youtubeUrl")))
                job_id = str(uuid.uuid4())
                now = job_time()
                job = {
                    "id": job_id,
                    "state": "queued",
                    "status": "Queued",
                    "createdAt": now,
                    "updatedAt": now,
                    "request": sanitize_request(payload),
                }
                with JOBS_LOCK:
                    cleanup_jobs_locked()
                    if active_jobs_locked() >= MAX_ACTIVE_JOBS:
                        send_json(self, 429, {"error": "The audio worker is busy. Please try again shortly."})
                        return
                    JOBS[job_id] = job
                    persist_job(job)
                thread = threading.Thread(target=run_job, args=(job_id, payload), daemon=True)
                thread.start()
                send_json(self, 202, public_job(job))
                return

            send_json(self, 200, transcribe(payload))
        except subprocess.TimeoutExpired:
            send_json(self, 504, {"error": "Audio transcription timed out."})
        except Exception as error:
            send_json(self, 422, {"error": str(error)})

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


if __name__ == "__main__":
    load_jobs_from_store()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"SolvysMIDI audio worker listening on {PORT}", flush=True)
    server.serve_forever()
