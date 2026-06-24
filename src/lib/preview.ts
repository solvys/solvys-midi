export type PreviewNote = {
  midi: number;
  time: number;
  duration: number;
  velocity: number;
};

export function makeWaveform(notes: PreviewNote[], durationSeconds: number, barCount = 64) {
  const duration = Math.max(durationSeconds, 1);
  const bars = Array.from({ length: barCount }, () => 0.08);

  notes.forEach((note) => {
    const start = Math.max(0, Math.floor((note.time / duration) * barCount));
    const end = Math.min(barCount - 1, Math.ceil(((note.time + note.duration) / duration) * barCount));
    for (let index = start; index <= end; index += 1) {
      const center = note.time + note.duration / 2;
      const barTime = (index / barCount) * duration;
      const distance = Math.abs(center - barTime);
      const pulse = Math.max(0, 1 - distance / Math.max(note.duration, 0.08));
      bars[index] = Math.min(1, Math.max(bars[index], note.velocity * (0.35 + pulse * 0.65)));
    }
  });

  return bars.map((bar, index) => {
    const drift = 0.08 * Math.sin(index * 0.9);
    return Number(Math.max(0.08, Math.min(1, bar + drift)).toFixed(3));
  });
}

export function midiToFrequency(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12);
}
