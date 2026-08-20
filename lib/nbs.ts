import type { MidiNote, ParsedMidi } from "./midi";

export type PitchMappingMode = "studio" | "smart" | "track-octave" | "note-octave" | "nbs-full";

export type NbsStats = {
  mappingMode: PitchMappingMode;
  totalNotes: number;
  melodicNotes: number;
  percussionNotes: number;
  nbsRangeFolded: number;
  octaveFolded: number;
  trackShifted: number;
  instrumentRemapped: number;
  transposed: number;
  percussionOutsideVanilla: number;
  percussionFallback: number;
  timingQuantized: number;
  maxTimingErrorMs: number;
  ticksPerSecond: number;
  velocityAdjusted: number;
  panned: number;
  pitchBent: number;
  layers: number;
  songLengthTicks: number;
  warnings: string[];
};

export type NbsResult = { bytes: Uint8Array; stats: NbsStats };
export type NbsOptions = {
  pitchMode?: PitchMappingMode;
  ticksPerSecond?: number | "auto";
  /** @deprecated Use pitchMode. Kept for older callers. */
  foldToVanillaRange?: boolean;
};

type NbsNote = { tick: number; layer: number; instrument: number; key: number; velocity: number; pan: number; pitch: number };

// GM program -> NBS vanilla instrument. This table is grouped by the 16 GM
// families and was rebuilt from measurements of NoteBlockStudio's actual OGG
// samples (attack, energy decay, spectral centroid/flatness and base pitch).
const PROGRAM_INSTRUMENT = [
  // Piano, chromatic percussion
  0,15,15,15,15,13,14,14, 7,7,7,10,9,9,8,14,
  // Organ, guitar
  6,15,13,6,6,6,6,6, 5,5,5,5,14,13,13,7,
  // Bass, strings
  1,1,1,12,1,1,12,12, 6,6,6,12,6,5,0,2,
  // Ensemble, brass
  6,6,15,15,6,6,15,15, 13,12,12,13,12,12,13,13,
  // Reed, pipe
  6,6,6,12,6,6,12,6, 6,6,6,6,6,6,6,6,
  // Synth lead, synth pad
  13,13,13,6,5,6,13,13, 8,15,13,6,6,8,8,8,
  // Synth effects, ethnic
  8,15,8,8,13,12,15,13, 14,14,14,14,10,6,6,6,
  // Percussive, sound effects
  7,11,10,4,2,2,3,8, 4,3,3,6,13,4,3,2,
];

// Key offset belongs to the selected sample, not to the GM program. It maps
// the sample's natural Minecraft pitch span to NBS key 33–57.
const INSTRUMENT_OCTAVE = [0,2,0,0,0,1,-1,-2,-2,-2,0,-1,2,0,0,0];

// MIDI drum note -> [NBS vanilla instrument index, NoteBlockStudio source key].
const DRUMS: Record<number, [number, number]> = {
  24:[13,39],25:[3,8],26:[4,25],27:[3,18],28:[3,27],29:[4,16],30:[4,13],31:[4,9],32:[4,6],33:[4,2],34:[8,17],
  35:[2,10],36:[2,6],37:[4,6],38:[3,8],39:[4,6],40:[3,4],41:[2,6],42:[3,22],43:[2,13],44:[3,22],45:[2,15],
  46:[3,18],47:[2,20],48:[2,23],49:[3,17],50:[2,23],51:[3,24],52:[3,8],53:[3,13],54:[4,18],55:[3,18],56:[11,5],
  57:[3,13],58:[4,2],59:[3,13],60:[4,9],61:[4,2],62:[4,8],63:[2,22],64:[2,15],65:[3,13],66:[3,8],67:[9,12],
  68:[9,5],69:[4,20],70:[4,23],71:[6,34],72:[6,33],73:[4,17],74:[4,11],75:[4,18],76:[4,10],77:[4,5],78:[12,25],
  79:[12,26],80:[4,16],81:[8,19],82:[3,22],83:[8,6],84:[8,15],85:[4,21],86:[2,14],87:[2,7],
};

const INSTRUMENT_BASE_MIDI = [54,30,-1,-1,-1,42,66,78,78,78,54,66,30,54,54,54];
const PITCHED_INSTRUMENTS = [0,1,5,6,7,8,9,10,11,12,13,14,15];

class Writer {
  private data = new Uint8Array(1024);
  private pos = 0;

  private reserve(length: number) {
    if (this.pos + length <= this.data.length) return;
    let size = this.data.length;
    while (size < this.pos + length) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.data);
    this.data = next;
  }
  u8(value: number) { this.reserve(1); this.data[this.pos++] = value & 0xff; }
  u16(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`NBS 16-bit 數值超出範圍：${value}`);
    this.reserve(2); this.data[this.pos++] = value & 0xff; this.data[this.pos++] = value >>> 8;
  }
  i16(value: number) {
    if (!Number.isInteger(value) || value < -32768 || value > 32767) throw new Error(`NBS signed 16-bit 數值超出範圍：${value}`);
    this.u16(value & 0xffff);
  }
  u32(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`NBS 32-bit 數值超出範圍：${value}`);
    this.reserve(4);
    this.data[this.pos++] = value & 0xff;
    this.data[this.pos++] = value >>> 8;
    this.data[this.pos++] = value >>> 16;
    this.data[this.pos++] = value >>> 24;
  }
  string(value: string) {
    // NBS v5 stores legacy single-byte strings, not UTF-8. Preserve Latin-1
    // characters and replace the rest; the original filename remains in the
    // browser summary where Unicode is safe.
    const bytes = Uint8Array.from([...value], (character) => {
      const code = character.codePointAt(0) ?? 63;
      return code <= 255 ? code : 63;
    });
    this.u32(bytes.length);
    this.reserve(bytes.length); this.data.set(bytes, this.pos); this.pos += bytes.length;
  }
  finish() { return this.data.slice(0, this.pos); }
}

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

function foldByOctave(value: number, min: number, max: number) {
  if (value >= min && value <= max) return value;
  for (let octaves = 1; octaves <= 10; octaves++) {
    if (value + 12 * octaves >= min && value + 12 * octaves <= max) return value + 12 * octaves;
    if (value - 12 * octaves >= min && value - 12 * octaves <= max) return value - 12 * octaves;
  }
  throw new Error(`音高 ${value} 無法以八度折返到 ${min}–${max}`);
}

function trackGroup(note: MidiNote) { return `${note.track}\0${note.channel}`; }

function chooseTrackOctaveOffsets(notes: MidiNote[]) {
  const groups = new Map<string, MidiNote[]>();
  for (const note of notes) {
    if (note.channel === 9) continue;
    const key = trackGroup(note);
    groups.set(key, [...(groups.get(key) || []), note]);
  }
  const offsets = new Map<string, number>();
  for (const [key, group] of groups) {
    let best = { offset: 0, outside: Number.POSITIVE_INFINITY, distance: Number.POSITIVE_INFINITY };
    for (let offset = -96; offset <= 96; offset += 12) {
      let outside = 0;
      let distance = 0;
      for (const note of group) {
        const shifted = note.note + offset;
        if (shifted < 30) { outside++; distance += 30 - shifted; }
        if (shifted > 102) { outside++; distance += shifted - 102; }
      }
      if (outside < best.outside ||
          (outside === best.outside && distance < best.distance) ||
          (outside === best.outside && distance === best.distance && Math.abs(offset) < Math.abs(best.offset))) {
        best = { offset, outside, distance };
      }
    }
    offsets.set(key, best.offset);
  }
  return offsets;
}

function mapNote(note: MidiNote, stats: NbsStats, mode: PitchMappingMode, trackOffsets: Map<string, number>) {
  if (note.channel === 9) {
    stats.percussionNotes++;
    const mapped = DRUMS[note.note];
    if (!mapped) {
      stats.percussionFallback++;
      stats.percussionOutsideVanilla++;
      return { instrument: 4, key: 0 };
    }
    const key = clamp(mapped[1], 0, 87);
    if (key < 33 || key > 57) stats.percussionOutsideVanilla++;
    return { instrument: mapped[0], key };
  }
  stats.melodicNotes++;
  const program = clamp(note.program, 0, 127);
  const preferred = PROGRAM_INSTRUMENT[program];
  const rawKey = note.note - 21 + 12 * INSTRUMENT_OCTAVE[preferred];
  if (mode === "studio" || mode === "nbs-full") {
    const key = foldByOctave(rawKey, 0, 87);
    if (key !== rawKey) { stats.nbsRangeFolded++; stats.transposed++; }
    return { instrument: preferred, key };
  }
  if (mode === "note-octave") {
    const key = foldByOctave(rawKey, 33, 57);
    if (key !== rawKey) { stats.octaveFolded++; stats.transposed++; }
    return { instrument: preferred, key };
  }

  const trackOffset = mode === "track-octave" ? trackOffsets.get(trackGroup(note)) || 0 : 0;
  const shiftedRawKey = rawKey + trackOffset;
  const shiftedTarget = note.note + trackOffset;
  const target = foldByOctave(shiftedTarget, 30, 102);
  if (trackOffset) stats.trackShifted++;
  if (target !== shiftedTarget) stats.octaveFolded++;
  if (target !== note.note) stats.transposed++;
  if (INSTRUMENT_BASE_MIDI[preferred] >= 0 && shiftedRawKey >= 33 && shiftedRawKey <= 57 && target === shiftedTarget) {
    return { instrument: preferred, key: shiftedRawKey };
  }
  const candidates = [preferred, ...PITCHED_INSTRUMENTS.filter((instrument) => instrument !== preferred)];
  const instrument = candidates.find((candidate) => {
    const base = INSTRUMENT_BASE_MIDI[candidate];
    return base >= 0 && target >= base && target <= base + 24;
  });
  if (instrument === undefined) throw new Error(`MIDI note ${note.note} 找不到可用樂器`);
  if (instrument !== preferred) stats.instrumentRemapped++;
  const vanillaKey = target - INSTRUMENT_BASE_MIDI[instrument] + 33;
  return { instrument, key: vanillaKey };
}

function midiPanToNbs(pan: number) {
  const value = clamp(Number.isFinite(pan) ? pan : 64, 0, 127);
  return value <= 64 ? Math.round(value / 64 * 100) : 100 + Math.round((value - 64) / 63 * 100);
}

function midiVelocityToNbs(note: MidiNote) {
  const velocity = clamp(note.velocity, 1, 127) / 127;
  const volume = clamp(Number.isFinite(note.channelVolume) ? note.channelVolume : 127, 0, 127) / 127;
  const expression = clamp(Number.isFinite(note.expression) ? note.expression : 127, 0, 127) / 127;
  return clamp(Math.round(velocity * volume * expression * 100), 1, 100);
}

function chooseTicksPerSecond(midi: ParsedMidi, requested: number | "auto") {
  if (requested !== "auto") {
    if (!Number.isFinite(requested) || requested < 0.25 || requested > 655.35) throw new Error(`NBS TPS 必須介於 0.25–655.35：${requested}`);
    // The v5 header stores tempo in hundredths of a tick per second. Use the
    // exact serialized value for quantization as well, so timing cannot drift.
    return Math.round(requested * 100) / 100;
  }
  if (midi.durationMicros <= 0) return 40;
  const maximum = Math.floor((0xffff * 1_000_000) / midi.durationMicros * 100) / 100;
  if (maximum < 0.25) throw new Error("歌曲太長，無法放入 NBS v5 的 65,535 ticks");
  return Math.min(40, maximum);
}

function allocateNotes(midi: ParsedMidi, stats: NbsStats, mode: PitchMappingMode): NbsNote[] {
  const ordered = midi.notes.map((note, index) => ({ note, index })).sort((a, b) =>
    a.note.micros - b.note.micros || a.note.track - b.note.track || a.note.channel - b.note.channel ||
    a.note.note - b.note.note || a.index - b.index,
  );
  const result: NbsNote[] = [];
  const trackOffsets = mode === "track-octave" ? chooseTrackOctaveOffsets(midi.notes) : new Map<string, number>();
  let currentTick = -1;
  let layer = 0;
  for (const { note } of ordered) {
    const tick = Math.max(0, Math.floor(note.micros * stats.ticksPerSecond / 1_000_000 + 0.5));
    if (tick > 0xffff) throw new Error("歌曲超過 NBS v5 的 65,535 ticks（約 109 分鐘）限制");
    const errorMs = Math.abs(tick * 1000 / stats.ticksPerSecond - note.micros / 1000);
    if (errorMs > 0.0001) stats.timingQuantized++;
    stats.maxTimingErrorMs = Math.max(stats.maxTimingErrorMs, errorMs);
    if (tick !== currentTick) { currentTick = tick; layer = 0; } else layer++;
    if (layer > 0xffff) throw new Error("單一時間點超過 NBS v5 的 65,536 layer 限制");
    const mapped = mapNote(note, stats, mode, trackOffsets);
    const velocity = midiVelocityToNbs(note);
    const pan = midiPanToNbs(note.pan);
    const pitch = note.channel === 9 ? 0 : clamp(Math.round(note.pitchBendCents || 0), -1200, 1200);
    if (velocity !== clamp(note.velocity, 1, 100)) stats.velocityAdjusted++;
    if (pan !== 100) stats.panned++;
    if (pitch !== 0) stats.pitchBent++;
    result.push({ tick, layer, instrument: mapped.instrument, key: mapped.key, velocity, pan, pitch });
    stats.layers = Math.max(stats.layers, layer + 1);
    stats.songLengthTicks = Math.max(stats.songLengthTicks, tick);
  }
  return result;
}

export function convertMidiToNbs(midi: ParsedMidi, sourceFileName: string, options: NbsOptions = {}): NbsResult {
  const mode = options.pitchMode ?? (options.foldToVanillaRange === false ? "nbs-full" : "studio");
  const ticksPerSecond = chooseTicksPerSecond(midi, options.ticksPerSecond ?? "auto");
  const stats: NbsStats = {
    mappingMode: mode, totalNotes: midi.notes.length, melodicNotes: 0, percussionNotes: 0,
    nbsRangeFolded: 0, octaveFolded: 0, trackShifted: 0, instrumentRemapped: 0,
    transposed: 0, percussionOutsideVanilla: 0,
    percussionFallback: 0, timingQuantized: 0, maxTimingErrorMs: 0, ticksPerSecond,
    velocityAdjusted: 0, panned: 0, pitchBent: 0, layers: 0,
    songLengthTicks: 0, warnings: [],
  };
  const notes = allocateNotes(midi, stats, mode);
  const writer = new Writer();
  writer.u16(0);                 // New-format marker.
  writer.u8(5);                  // Open Note Block Studio v5.
  writer.u8(16);                 // Vanilla instrument count.
  writer.u16(stats.songLengthTicks);
  writer.u16(stats.layers);
  writer.string(midi.name);
  writer.string("");            // Author.
  writer.string("");            // Original author.
  writer.string("Converted locally with Note Block Forge");
  writer.u16(Math.round(stats.ticksPerSecond * 100));
  writer.u8(0);                  // Legacy autosave disabled.
  writer.u8(10);
  writer.u8(4);
  writer.u32(0); writer.u32(0); writer.u32(0); writer.u32(0); writer.u32(0);
  writer.string(sourceFileName);
  writer.u8(0); writer.u8(0); writer.u16(0); // Loop settings.

  let previousTick = -1;
  let index = 0;
  while (index < notes.length) {
    const tick = notes[index].tick;
    writer.u16(tick - previousTick);
    previousTick = tick;
    let previousLayer = -1;
    while (index < notes.length && notes[index].tick === tick) {
      const note = notes[index++];
      writer.u16(note.layer - previousLayer);
      previousLayer = note.layer;
      writer.u8(note.instrument);
      writer.u8(note.key);
      writer.u8(note.velocity);
      writer.u8(note.pan);
      writer.i16(note.pitch);
    }
    writer.u16(0);
  }
  writer.u16(0);

  for (let layer = 0; layer < stats.layers; layer++) {
    writer.string(`Voice ${layer + 1}`);
    writer.u8(0); writer.u8(100); writer.u8(100);
  }
  writer.u8(0);                  // No custom instruments.

  if (stats.nbsRangeFolded) stats.warnings.push(`${stats.nbsRangeFolded} 個超出 NBS 0–87 的旋律音符以八度折返，沒有直接裁切`);
  if (stats.trackShifted) stats.warnings.push(`${stats.trackShifted} 個旋律音符依所屬軌道統一升／降八度`);
  if (stats.octaveFolded) stats.warnings.push(`${stats.octaveFolded} 個旋律音符個別以八度折返到可播放區域`);
  if (stats.instrumentRemapped) stats.warnings.push(`${stats.instrumentRemapped} 個旋律音符更換為可覆蓋音高的原版樂器`);
  if (stats.percussionOutsideVanilla) stats.warnings.push(`${stats.percussionOutsideVanilla} 個打擊音保留 NoteBlockStudio 原始 key（可能位於 33–57 外）`);
  if (stats.percussionFallback) stats.warnings.push(`${stats.percussionFallback} 個未定義打擊音使用 hi-hat fallback`);
  if (stats.timingQuantized) stats.warnings.push(`${stats.timingQuantized} 個音符量化到 ${stats.ticksPerSecond.toFixed(2)} TPS；最大誤差 ${stats.maxTimingErrorMs.toFixed(2)} ms`);
  return { bytes: writer.finish(), stats };
}
