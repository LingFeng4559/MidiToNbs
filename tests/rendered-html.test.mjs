import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders Note Block Forge", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Note Block Forge/);
  assert.match(html, /OPEN NOTE BLOCK STUDIO/);
  assert.match(html, /100% 本機運算/);
  assert.match(html, /下載 NBS/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("wires the real browser conversion pipeline and removes starter assets", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /parseMidi\(/);
  assert.match(page, /convertMidiToNbs\(/);
  assert.match(page, /makeZip\(/);
  assert.match(page, /\.nbs/);
  assert.match(page, /onDrop=/);
  assert.match(page, /放開滑鼠，即可加入 MIDI/);
  assert.match(page, /個 MIDI 已加入清單/);
  assert.match(page, /aria-live="assertive"/);
  assert.match(layout, /Open Note Block Studio NBS/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
});
