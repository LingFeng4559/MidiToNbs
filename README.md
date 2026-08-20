# Note Block Forge

Browser-local batch converter from Standard MIDI/RMID to true Open Note Block Studio `.nbs` files.

## Live site

<https://lingfeng4559.github.io/MidiToNbs/>

## Privacy

MIDI files are parsed entirely inside the browser. They are not uploaded to a server. Generated NBS files can be downloaded individually or as a ZIP containing a JSON conversion summary.

## Format and mapping

- Writes uncompressed Open Note Block Studio NBS version 5 binary data, not renamed NBT.
- Uses the 128-entry General MIDI instrument and percussion mappings from the local OpenNoteBlockStudio v3.11.0 reference project.
- Applies the full MIDI tempo map before quantizing note starts to 100 ms; the NBS header therefore uses 10.00 ticks per second.
- Preserves channel 9 percussion with the official NoteBlockStudio drum keys.
- The default Minecraft-compatible melody mode remaps instruments or octave-transposes melodic notes into NBS keys 33–57. Disable it to preserve the broader legal NBS 0–87 melody range.
- NBS v5 stores metadata as legacy single-byte strings, so unsupported Unicode characters inside the song metadata are replaced with `?`. Unicode filenames remain intact in browser downloads and the JSON summary.

NBS v5 uses unsigned 16-bit song length, layer count, tick jumps, and layer jumps. Files exceeding those limits fail individually without stopping the batch.

## Development

Requires Node.js 22.13 or newer.

```text
npm ci
npm run dev
npm run build
npm run build:pages
node --test tests/rendered-html.test.mjs
```

Pushes to `main` are published automatically to GitHub Pages by the
`deploy-pages.yml` workflow.

The independent round-trip fixture generator can be run with:

```text
npx tsx tests/generate-nbs.ts input.mid output.nbs
```

The generated file can be validated using `pynbs.read()` or Open Note Block Studio itself.
