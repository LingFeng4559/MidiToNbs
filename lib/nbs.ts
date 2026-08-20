import type { MidiNote, ParsedMidi } from "./midi";

export type NbsStats = {
  totalNotes: number;
  melodicNotes: number;
  percussionNotes: number;
  pitchClamped: number;
  octaveFolded: number;
  instrumentRemapped: number;
  transposed: number;
  percussionOutsideVanilla: number;
  percussionFallback: number;
  timingQuantized: number;
  maxTimingErrorMs: number;
  layers: number;
  songLengthTicks: number;
  warnings: string[];
};

export type NbsResult = { bytes: Uint8Array; stats: NbsStats };
export type NbsOptions = { foldToVanillaRange?: boolean };

type NbsNote = { tick: number; layer: number; instrument: number; key: number; velocity: number };

const PROGRAM_INSTRUMENT = [
  0,15,15,15,0,0,5,14,7,7,7,10,10,9,7,5,6,10,6,6,6,6,6,6,5,5,0,5,1,12,12,5,
  1,1,1,1,5,5,1,15,6,6,6,6,6,1,0,3,6,6,6,6,6,6,6,3,6,6,6,12,6,12,12,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,13,6,6,6,5,6,6,1,7,6,6,6,6,6,6,8,
  8,6,8,5,15,6,6,5,14,14,14,5,10,6,6,6,8,11,10,9,2,3,3,8,4,6,8,6,7,2,3,3,
];

const PROGRAM_OCTAVE = [
  0,0,0,0,0,0,1,0,-2,-2,-2,0,0,-2,-2,1,-1,0,-1,-1,-1,-1,-1,-1,1,1,0,1,2,2,2,3,
  2,2,2,2,1,1,2,0,-1,-1,-1,-1,-1,2,0,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,2,-1,2,2,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,-1,-1,1,-1,-1,2,-2,-1,-1,-1,-1,-1,-1,-2,
  -2,-1,-2,1,0,-1,-1,1,0,0,0,1,0,-1,-1,-1,-2,-1,0,-2,0,0,0,-2,1,-1,-2,1,2,0,0,0,
];

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

function nearestVanillaPitch(note: number) {
  if (note >= 30 && note <= 102) return note;
  for (let octaves = 1; octaves <= 10; octaves++) {
    if (note + 12 * octaves >= 30 && note + 12 * octaves <= 102) return note + 12 * octaves;
    if (note - 12 * octaves >= 30 && note - 12 * octaves <= 102) return note - 12 * octaves;
  }
  throw new Error(`MIDI note ${note} 無法映射到原版 Note Block 音域`);
}

function mapNote(note: MidiNote, stats: NbsStats, foldToVanillaRange: boolean) {
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
  const rawKey = note.note - 21 + 12 * PROGRAM_OCTAVE[program];
  const key = clamp(rawKey, 0, 87);
  if (key !== rawKey) stats.pitchClamped++;
  const preferred = PROGRAM_INSTRUMENT[program];
  if (!foldToVanillaRange) return { instrument: preferred, key };
  if (INSTRUMENT_BASE_MIDI[preferred] >= 0 && rawKey >= 33 && rawKey <= 57) return { instrument: preferred, key: rawKey };

  const target = nearestVanillaPitch(note.note);
  const candidates = [preferred, ...PITCHED_INSTRUMENTS.filter((instrument) => instrument !== preferred)];
  const instrument = candidates.find((candidate) => {
    const base = INSTRUMENT_BASE_MIDI[candidate];
    return base >= 0 && target >= base && target <= base + 24;
  });
  if (instrument === undefined) throw new Error(`MIDI note ${note.note} 找不到可用樂器`);
  if (instrument !== preferred) stats.instrumentRemapped++;
  if (target !== note.note) stats.transposed++;
  const vanillaKey = target - INSTRUMENT_BASE_MIDI[instrument] + 33;
  if (vanillaKey !== rawKey) stats.octaveFolded++;
  return { instrument, key: vanillaKey };
}

function allocateNotes(midi: ParsedMidi, stats: NbsStats, foldToVanillaRange: boolean): NbsNote[] {
  const ordered = midi.notes.map((note, index) => ({ note, index })).sort((a, b) =>
    a.note.micros - b.note.micros || a.note.track - b.note.track || a.note.channel - b.note.channel ||
    a.note.note - b.note.note || a.index - b.index,
  );
  const result: NbsNote[] = [];
  let currentTick = -1;
  let layer = 0;
  for (const { note } of ordered) {
    const tick = Math.max(0, Math.floor(note.micros / 100_000 + 0.5));
    if (tick > 0xffff) throw new Error("歌曲超過 NBS v5 的 65,535 ticks（約 109 分鐘）限制");
    const errorMs = Math.abs(tick * 100 - note.micros / 1000);
    if (errorMs > 0.0001) stats.timingQuantized++;
    stats.maxTimingErrorMs = Math.max(stats.maxTimingErrorMs, errorMs);
    if (tick !== currentTick) { currentTick = tick; layer = 0; } else layer++;
    if (layer > 0xffff) throw new Error("單一時間點超過 NBS v5 的 65,536 layer 限制");
    const mapped = mapNote(note, stats, foldToVanillaRange);
    result.push({ tick, layer, instrument: mapped.instrument, key: mapped.key, velocity: clamp(note.velocity, 1, 100) });
    stats.layers = Math.max(stats.layers, layer + 1);
    stats.songLengthTicks = Math.max(stats.songLengthTicks, tick);
  }
  return result;
}

export function convertMidiToNbs(midi: ParsedMidi, sourceFileName: string, options: NbsOptions = {}): NbsResult {
  const foldToVanillaRange = options.foldToVanillaRange ?? true;
  const stats: NbsStats = {
    totalNotes: midi.notes.length, melodicNotes: 0, percussionNotes: 0, pitchClamped: 0, octaveFolded: 0,
    instrumentRemapped: 0, transposed: 0, percussionOutsideVanilla: 0,
    percussionFallback: 0, timingQuantized: 0, maxTimingErrorMs: 0, layers: 0,
    songLengthTicks: 0, warnings: [],
  };
  const notes = allocateNotes(midi, stats, foldToVanillaRange);
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
  writer.u16(1000);              // 10.00 ticks/s = 100 ms per tick.
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
      writer.u8(100);            // Center panning in serialized 0..200 range.
      writer.i16(0);             // Fine pitch in cents.
    }
    writer.u16(0);
  }
  writer.u16(0);

  for (let layer = 0; layer < stats.layers; layer++) {
    writer.string(`Voice ${layer + 1}`);
    writer.u8(0); writer.u8(100); writer.u8(100);
  }
  writer.u8(0);                  // No custom instruments.

  if (stats.pitchClamped) stats.warnings.push(`${stats.pitchClamped} 個旋律音高被限制到 NBS 0–87`);
  if (stats.octaveFolded) stats.warnings.push(`${stats.octaveFolded} 個音符以八度折疊到原版 33–57 音域`);
  if (stats.instrumentRemapped) stats.warnings.push(`${stats.instrumentRemapped} 個旋律音符更換為可覆蓋音高的原版樂器`);
  if (stats.transposed) stats.warnings.push(`${stats.transposed} 個極端旋律音符做最小八度轉調`);
  if (stats.percussionOutsideVanilla) stats.warnings.push(`${stats.percussionOutsideVanilla} 個打擊音保留 NoteBlockStudio 原始 key（可能位於 33–57 外）`);
  if (stats.percussionFallback) stats.warnings.push(`${stats.percussionFallback} 個未定義打擊音使用 hi-hat fallback`);
  if (stats.timingQuantized) stats.warnings.push(`${stats.timingQuantized} 個音符量化到 100 ms；最大誤差 ${stats.maxTimingErrorMs.toFixed(2)} ms`);
  return { bytes: writer.finish(), stats };
}
