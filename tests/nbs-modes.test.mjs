import assert from "node:assert/strict";
import test from "node:test";
import { convertMidiToNbs } from "../lib/nbs.ts";

function fixture() {
  const note = (value, channel = 0) => ({ tick: 0, micros: 0, note: value, velocity: 90, channel, program: 0, track: 0 });
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
  for (const pitchMode of ["smart", "track-octave", "note-octave", "nbs-full"]) {
    const result = convertMidiToNbs(fixture(), "fixture.mid", { pitchMode });
    const notes = readNotes(result.bytes);
    assert.equal(notes.length, 4);
    const melodic = notes.filter((note) => note.instrument !== 2 && note.instrument !== 3 && note.instrument !== 4);
    const min = pitchMode === "nbs-full" ? 0 : 33;
    const max = pitchMode === "nbs-full" ? 87 : 57;
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
