export type MidiNote = {
  tick: number;
  micros: number;
  note: number;
  velocity: number;
  channel: number;
  program: number;
  track: number;
};

export type ParsedMidi = {
  name: string;
  format: number;
  ppq: number;
  durationMicros: number;
  notes: MidiNote[];
  tempoEvents: number;
  trackCount: number;
};

type RawEvent = {
  tick: number;
  track: number;
  order: number;
  kind: "note" | "program" | "tempo" | "name";
  channel?: number;
  note?: number;
  velocity?: number;
  program?: number;
  tempo?: number;
  text?: string;
};

class Reader {
  private view: DataView;
  pos = 0;

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining() { return this.bytes.length - this.pos; }
  u8() { this.need(1); return this.bytes[this.pos++]; }
  u16() { this.need(2); const value = this.view.getUint16(this.pos, false); this.pos += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.pos, false); this.pos += 4; return value; }
  ascii(length: number) {
    this.need(length);
    const value = String.fromCharCode(...this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return value;
  }
  take(length: number) { this.need(length); const value = this.bytes.subarray(this.pos, this.pos + length); this.pos += length; return value; }
  skip(length: number) { this.need(length); this.pos += length; }
  vlq() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const current = this.u8();
      value = value * 128 + (current & 0x7f);
      if ((current & 0x80) === 0) return value;
    }
    throw new Error("無效的 MIDI variable-length quantity");
  }
  private need(length: number) {
    if (length < 0 || this.pos + length > this.bytes.length) throw new Error("MIDI 資料意外結束");
  }
}

function unwrapRmid(input: Uint8Array) {
  if (input.length < 12 || new TextDecoder("ascii").decode(input.subarray(0, 4)) !== "RIFF") return input;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (new TextDecoder("ascii").decode(input.subarray(8, 12)) !== "RMID") throw new Error("RIFF 檔案不是 RMID");
  let pos = 12;
  while (pos + 8 <= input.length) {
    const id = new TextDecoder("ascii").decode(input.subarray(pos, pos + 4));
    const size = view.getUint32(pos + 4, true);
    pos += 8;
    if (pos + size > input.length) throw new Error("RMID chunk 超出檔案範圍");
    if (id === "data") return input.subarray(pos, pos + size);
    pos += size + (size & 1);
  }
  throw new Error("RMID 找不到 data chunk");
}

function parseTrack(bytes: Uint8Array, track: number): RawEvent[] {
  const reader = new Reader(bytes);
  const events: RawEvent[] = [];
  let tick = 0;
  let running = -1;
  let order = 0;
  const decoder = new TextDecoder("utf-8", { fatal: false });

  while (reader.remaining > 0) {
    tick += reader.vlq();
    let status = reader.u8();
    let firstData: number | undefined;
    if (status < 0x80) {
      if (running < 0) throw new Error("MIDI running status 缺少前一個狀態");
      firstData = status;
      status = running;
    } else if (status < 0xf0) {
      running = status;
    }

    if (status === 0xff) {
      running = -1;
      const type = reader.u8();
      const length = reader.vlq();
      const data = reader.take(length);
      if (type === 0x2f) break;
      if (type === 0x51 && data.length === 3) {
        events.push({ tick, track, order: order++, kind: "tempo", tempo: data[0] * 65536 + data[1] * 256 + data[2] });
      } else if (type === 0x03) {
        events.push({ tick, track, order: order++, kind: "name", text: decoder.decode(data) });
      }
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      running = -1;
      reader.skip(reader.vlq());
      continue;
    }
    if (status >= 0xf0) {
      running = -1;
      const systemLengths: Record<number, number> = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf6: 0, 0xf8: 0, 0xfa: 0, 0xfb: 0, 0xfc: 0, 0xfe: 0 };
      const length = systemLengths[status];
      if (length === undefined) throw new Error(`不支援的 MIDI system event 0x${status.toString(16)}`);
      reader.skip(length);
      continue;
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;
    const data1 = firstData ?? reader.u8();
    const oneByte = command === 0xc0 || command === 0xd0;
    const data2 = oneByte ? 0 : reader.u8();
    if (command === 0x90 && data2 > 0) {
      events.push({ tick, track, order: order++, kind: "note", channel, note: data1, velocity: data2 });
    } else if (command === 0xc0) {
      events.push({ tick, track, order: order++, kind: "program", channel, program: data1 });
    }
  }
  return events;
}

export function parseMidi(input: ArrayBuffer, fallbackName: string): ParsedMidi {
  const bytes = unwrapRmid(new Uint8Array(input));
  const reader = new Reader(bytes);
  if (reader.ascii(4) !== "MThd") throw new Error("不是 Standard MIDI/RMID 檔案");
  const headerLength = reader.u32();
  if (headerLength < 6) throw new Error("MIDI header 太短");
  const format = reader.u16();
  const trackCount = reader.u16();
  const division = reader.u16();
  reader.skip(headerLength - 6);
  if ((division & 0x8000) !== 0) throw new Error("目前不支援 SMPTE timing MIDI");
  if (division === 0) throw new Error("MIDI PPQ 不可為 0");

  const events: RawEvent[] = [];
  for (let track = 0; track < trackCount; track++) {
    if (reader.ascii(4) !== "MTrk") throw new Error(`第 ${track + 1} 軌缺少 MTrk header`);
    events.push(...parseTrack(reader.take(reader.u32()), track));
  }
  events.sort((a, b) => a.tick - b.tick || a.track - b.track || a.order - b.order);

  const tempos = events.filter((event) => event.kind === "tempo" && event.tempo && event.tempo > 0);
  const tempoSegments: { tick: number; micros: number; tempo: number }[] = [{ tick: 0, micros: 0, tempo: 500_000 }];
  for (const event of tempos) {
    const previous = tempoSegments[tempoSegments.length - 1];
    const micros = previous.micros + ((event.tick - previous.tick) * previous.tempo) / division;
    if (event.tick === previous.tick) tempoSegments[tempoSegments.length - 1] = { tick: event.tick, micros, tempo: event.tempo! };
    else tempoSegments.push({ tick: event.tick, micros, tempo: event.tempo! });
  }
  const tickToMicros = (tick: number) => {
    let low = 0, high = tempoSegments.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (tempoSegments[mid].tick <= tick) low = mid; else high = mid - 1;
    }
    const segment = tempoSegments[low];
    return segment.micros + ((tick - segment.tick) * segment.tempo) / division;
  };

  const programs = new Array(16).fill(0);
  const notes: MidiNote[] = [];
  for (const event of events) {
    if (event.kind === "program") programs[event.channel!] = event.program!;
    if (event.kind === "note") notes.push({
      tick: event.tick,
      micros: tickToMicros(event.tick),
      note: event.note!,
      velocity: event.velocity!,
      channel: event.channel!,
      program: programs[event.channel!],
      track: event.track,
    });
  }
  const name = events.find((event) => event.kind === "name" && event.text?.trim())?.text?.trim() || fallbackName;
  const durationMicros = notes.reduce((max, note) => Math.max(max, note.micros), 0);
  return { name, format, ppq: division, durationMicros, notes, tempoEvents: tempos.length, trackCount };
}
