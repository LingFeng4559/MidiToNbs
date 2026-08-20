import { readFileSync, writeFileSync } from "node:fs";
import { parseMidi } from "../lib/midi";
import { convertMidiToNbs } from "../lib/nbs";
import { makeZip } from "../lib/zip";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: generate-nbs.ts <input.mid> <output.nbs>");
const source = readFileSync(input);
const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
const midi = parseMidi(arrayBuffer, "Roundtrip fixture");
const result = convertMidiToNbs(midi, "fixture.mid", { pitchMode: "smart" });
writeFileSync(output, result.bytes);
const summary = new TextEncoder().encode(JSON.stringify({ source: "fixture.mid", stats: result.stats }, null, 2));
const zip = makeZip([{ name: "fixture.nbs", data: result.bytes }, { name: "conversion-summary.json", data: summary }]);
writeFileSync(`${output}.zip`, new Uint8Array(await zip.arrayBuffer()));
console.log(JSON.stringify({ midiNotes: midi.notes.length, nbsBytes: result.bytes.length, zipBytes: zip.size, stats: result.stats }));
