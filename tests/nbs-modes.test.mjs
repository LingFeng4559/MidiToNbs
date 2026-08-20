import assert from "node:assert/strict";
import test from "node:test";
import { convertMidiToNbs } from "../lib/nbs.ts";
import { parseMidi } from "../lib/midi.ts";

function fixture() {
  const note = (value, channel = 0) => ({
    tick: 0, micros: 0, note: value, velocity: 90, channel, program: 0, track: 0,
    pan: 64, channelVolume: 127, expression: 127, pitchBendCents: 0,
  });
  return {
    name: "Pitch modes", format: 1, ppq: 480, durationMicros: 0, tempoEvents: 1, trackCount: 1,
    notes: [note(10), note(60), note(110), note(36, 9)],
  };
}

function readNotes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const u8 = () => view.getUint8(pos++);
  const u16 = () => { const value = view.getUint16(pos, true); pos += 2; return value; };
  const u32 = () => { const value = view.getUint32(pos, true); pos += 4; return value; };
  const skipString = () => { const length = u32(); pos += length; };
  u16(); u8(); u8(); u16(); u16();
  skipString(); skipString(); skipString(); skipString();
  u16(); u8(); u8(); u8();
  for (let index = 0; index < 5; index++) u32();
  skipString(); u8(); u8(); u16();
  const notes = [];
  let tick = -1;
  while (true) {
    const tickJump = u16();
    if (!tickJump) break;
    tick += tickJump;
    let layer = -1;
    while (true) {
      const layerJump = u16();
      if (!layerJump) break;
      layer += layerJump;
      const instrument = u8();
      const key = u8();
      const velocity = u8();
      const pan = u8();
      const pitch = u16();
      notes.push({ tick, layer, instrument, key, velocity, pan, pitch });
    }
  }
  return notes;
}

test("all selectable pitch modes avoid direct boundary clipping", () => {
  for (const pitchMode of ["studio", "smart", "track-octave", "note-octave", "nbs-full"]) {
    const result = convertMidiToNbs(fixture(), "fixture.mid", { pitchMode });
    const notes = readNotes(result.bytes);
    assert.equal(notes.length, 4);
    const melodic = notes.filter((note) => note.instrument !== 2 && note.instrument !== 3 && note.instrument !== 4);
    const fullRange = pitchMode === "studio" || pitchMode === "nbs-full";
    const min = fullRange ? 0 : 33;
    const max = fullRange ? 87 : 57;
    assert.ok(melodic.every((note) => note.key >= min && note.key <= max), pitchMode);
    assert.ok(!melodic.some((note) => note.key === min || note.key === max), `${pitchMode} must octave-fold, not clamp to a boundary`);
    assert.equal(notes.find((note) => note.instrument === 2)?.key, 6, "percussion keeps the NoteBlockStudio drum key");
  }
});

test("track mode applies one octave shift before per-note fallback", () => {
  const result = convertMidiToNbs(fixture(), "fixture.mid", { pitchMode: "track-octave" });
  assert.equal(result.stats.mappingMode, "track-octave");
  assert.equal(result.stats.trackShifted, 3);
  assert.equal(result.stats.octaveFolded, 1);
});

test("full NBS mode folds only values outside the v5 key range", () => {
  const result = convertMidiToNbs(fixture(), "fixture.mid", { pitchMode: "nbs-full" });
  const keys = readNotes(result.bytes).filter((note) => note.instrument !== 2).map((note) => note.key);
  assert.deepEqual(keys, [1, 39, 77]);
  assert.equal(result.stats.nbsRangeFolded, 2);
});

test("high fidelity mode preserves MIDI volume, pan, and note-on pitch bend", () => {
  const track = [
    0x00,0xb0,0x07,0x64, 0x00,0xb0,0x0a,0x00,
    0x00,0xb0,0x65,0x00, 0x00,0xb0,0x64,0x00, 0x00,0xb0,0x06,0x0c,
    0x00,0xe0,0x00,0x60, 0x00,0x90,0x3c,0x7f, 0x00,0xff,0x2f,0x00,
  ];
  const bytes = Uint8Array.from([
    0x4d,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, 1,0xe0,
    0x4d,0x54,0x72,0x6b, 0,0,0,track.length, ...track,
  ]);
  const midi = parseMidi(bytes.buffer, "expression");
  assert.equal(midi.notes[0].channelVolume, 100);
  assert.equal(midi.notes[0].pan, 0);
  assert.equal(midi.notes[0].pitchBendCents, 600);
  const result = convertMidiToNbs(midi, "expression.mid", { pitchMode: "studio", ticksPerSecond: "auto" });
  const [note] = readNotes(result.bytes);
  assert.equal(note.velocity, 79);
  assert.equal(note.pan, 0);
  assert.equal(note.pitch, 600);
});

test("automatic timing uses 40 TPS and reduces quantization error", () => {
  const midi = fixture();
  midi.notes = [{ ...midi.notes[0], micros: 123_456 }];
  midi.durationMicros = 123_456;
  const result = convertMidiToNbs(midi, "timing.mid", { pitchMode: "studio", ticksPerSecond: "auto" });
  assert.equal(result.stats.ticksPerSecond, 40);
  assert.equal(readNotes(result.bytes)[0].tick, 5);
  assert.ok(result.stats.maxTimingErrorMs < 13);
});

test("acoustic mapping selects representative NoteBlockStudio samples", () => {
  const expected = new Map([
    [0, 0],    // Acoustic grand piano -> harp.
    [6, 14],   // Harpsichord -> banjo's fast, bright transient.
    [24, 5],   // Nylon guitar -> guitar.
    [32, 1],   // Acoustic bass -> double bass.
    [40, 6],   // Violin -> flute, the closest sustained vanilla sample.
    [56, 13],  // Trumpet -> bit, a bright sustained sample.
    [112, 7],  // Tinkle bell -> bell.
  ]);
  for (const [program, instrument] of expected) {
    const midi = fixture();
    midi.notes = [{ ...midi.notes[1], program }];
    const [note] = readNotes(convertMidiToNbs(midi, "mapping.mid", { pitchMode: "studio" }).bytes);
    assert.equal(note.instrument, instrument, `GM program ${program}`);
  }
});
