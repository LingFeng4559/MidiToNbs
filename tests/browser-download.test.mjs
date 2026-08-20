import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const edge = process.env.EDGE_PATH
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const midi = process.env.TEST_MIDI;
assert(midi && fs.existsSync(midi), "Set TEST_MIDI to an existing MIDI file");

const browser = await chromium.launch({ executablePath: edge, headless: true });
const page = await browser.newPage({ acceptDownloads: true });
try {
  await page.goto(process.env.TEST_URL ?? "http://127.0.0.1:3000/", { waitUntil: "networkidle" });
  await page.locator('input[type="file"]').first().setInputFiles(midi);
  await page.getByRole("button", { name: "開始本機轉換" }).click();
  await page.getByRole("button", { name: "下載 .nbs" }).waitFor();

  const singlePromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載 .nbs" }).click();
  const single = await singlePromise;
  assert.equal(path.extname(single.suggestedFilename()).toLowerCase(), ".nbs");
  const artifacts = path.resolve("test-output", "browser-downloads");
  fs.mkdirSync(artifacts, { recursive: true });
  await single.saveAs(path.join(artifacts, single.suggestedFilename()));

  const zipPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載全部 ZIP" }).click();
  const zip = await zipPromise;
  assert.equal(path.extname(zip.suggestedFilename()).toLowerCase(), ".zip");
  await zip.saveAs(path.join(artifacts, zip.suggestedFilename()));

  console.log(JSON.stringify({
    single: single.suggestedFilename(),
    zip: zip.suggestedFilename(),
    status: "PASS",
  }));
} finally {
  await Promise.race([
    browser.close(),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}
process.exit(0);
