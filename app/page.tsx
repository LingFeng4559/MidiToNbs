"use client";

import { useMemo, useRef, useState, type InputHTMLAttributes } from "react";
import { parseMidi } from "../lib/midi";
import { convertMidiToNbs, type NbsStats, type PitchMappingMode } from "../lib/nbs";
import { makeZip } from "../lib/zip";

type Status = "ready" | "processing" | "success" | "error";
type DropFeedback = { tone: "success" | "warning"; message: string };
type WorkItem = {
  id: string;
  file: File;
  relativeName: string;
  status: Status;
  bytes?: Uint8Array;
  stats?: NbsStats;
  error?: string;
};

const directoryProps = { webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>;
const pitchModes: Array<{ value: PitchMappingMode; title: string; description: string; recommended?: boolean }> = [
  { value: "studio", title: "NoteBlockStudio 高還原", description: "依 16 種實際音源的起音、衰減、頻譜與基準音高重建映射，並使用完整 0–87 音域。", recommended: true },
  { value: "smart", title: "智慧樂器映射", description: "優先更換可覆蓋音高的原版樂器；只有極端音符才升降八度。" },
  { value: "track-octave", title: "整軌八度轉調", description: "同一軌道統一升八或降八，盡量維持旋律與和聲的相對關係。" },
  { value: "note-octave", title: "逐音符八度折返", description: "超出原版區域的音符以 ±12 半音折返；保留音名，但可能產生八度跳動。" },
];
const timingModes = [
  { value: "auto" as const, title: "自動高精度", description: "最高使用 40 TPS，長曲目會自動降低以符合 NBS v5 長度限制。" },
  { value: 20 as const, title: "20 TPS", description: "每 tick 50 ms，適合遊戲 tick 對齊。" },
  { value: 10 as const, title: "紅石 10 TPS", description: "每 tick 100 ms；只在需要紅石相容時使用。" },
];

function outputName(name: string) { return name.replace(/\.(midi?|rmi)$/i, "") + ".nbs"; }
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function Home() {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dropFeedback, setDropFeedback] = useState<DropFeedback | null>(null);
  const knownFileIds = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [pitchMode, setPitchMode] = useState<PitchMappingMode>("studio");
  const [timingMode, setTimingMode] = useState<"auto" | 20 | 10>("auto");

  const counts = useMemo(() => ({
    success: items.filter((item) => item.status === "success").length,
    error: items.filter((item) => item.status === "error").length,
    done: items.filter((item) => item.status === "success" || item.status === "error").length,
  }), [items]);

  function addFiles(files: Iterable<File>) {
    const incoming = [...files];
    const accepted = incoming.filter((file) => /\.(mid|midi|rmi)$/i.test(file.name));
    const additions = accepted.flatMap((file) => {
      const relativeName = file.webkitRelativePath || file.name;
      const id = `${relativeName}\0${file.size}\0${file.lastModified}`;
      if (knownFileIds.current.has(id)) return [];
      knownFileIds.current.add(id);
      return [{ id, file, relativeName, status: "ready" as const }];
    });

    if (additions.length) setItems((current) => [...current, ...additions]);

    const skipped = accepted.length - additions.length;
    if (!accepted.length) {
      setDropFeedback({ tone: "warning", message: "沒有找到可用的 MIDI 檔，請拖入 .mid、.midi 或 .rmi。" });
    } else if (!additions.length) {
      setDropFeedback({ tone: "warning", message: `${accepted.length} 個 MIDI 已經在清單中，沒有重複加入。` });
    } else {
      setDropFeedback({
        tone: "success",
        message: `${additions.length} 個 MIDI 已加入清單${skipped ? `，另有 ${skipped} 個重複檔案略過` : ""}。`,
      });
    }
  }

  function invalidateResults() {
    setItems((current) => current.map((item) => ({ ...item, status: "ready", bytes: undefined, stats: undefined, error: undefined })));
  }

  async function convertAll() {
    if (busy || !items.length) return;
    setBusy(true);
    const working: WorkItem[] = items.map((item) => ({ ...item, status: "ready" as Status, bytes: undefined, stats: undefined, error: undefined }));
    setItems(working);
    for (let index = 0; index < working.length; index++) {
      working[index] = { ...working[index], status: "processing" };
      setItems([...working]);
      try {
        const midi = parseMidi(await working[index].file.arrayBuffer(), outputName(working[index].file.name).replace(/\.nbs$/i, ""));
        const result = convertMidiToNbs(midi, working[index].file.name, { pitchMode, ticksPerSecond: timingMode });
        working[index] = { ...working[index], status: "success", bytes: result.bytes, stats: result.stats };
      } catch (error) {
        working[index] = { ...working[index], status: "error", error: error instanceof Error ? error.message : String(error) };
      }
      setItems([...working]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    setBusy(false);
  }

  function downloadOne(item: WorkItem) {
    if (!item.bytes) return;
    download(new Blob([item.bytes], { type: "audio/vnd.opennbs.nbs" }), outputName(item.file.name));
  }

  function downloadAll() {
    const successes = items.filter((item) => item.status === "success" && item.bytes);
    const summary = {
      generatedAt: new Date().toISOString(), format: "Open Note Block Studio v5",
      pitchMappingMode: pitchMode, timingMode, filesFound: items.length, succeeded: successes.length,
      failed: items.length - successes.length,
      results: items.map((item) => ({ input: item.relativeName, output: outputName(item.relativeName), status: item.status, error: item.error, stats: item.stats })),
    };
    const entries = successes.map((item) => ({ name: outputName(item.relativeName), data: item.bytes! }));
    entries.push({ name: "conversion-summary.json", data: new TextEncoder().encode(JSON.stringify(summary, null, 2)) });
    download(makeZip(entries), "note-block-forge-nbs.zip");
  }

  return (
    <main className="shell">
      <nav className="topbar" aria-label="主要導覽">
        <a className="brand" href="#top"><span className="brandMark" aria-hidden="true"><i /><i /><i /><i /></span><span>NOTE BLOCK <b>FORGE</b></span></a>
        <span className="privacyPill"><i />100% 本機運算</span>
      </nav>

      <section className="hero" id="top">
        <div className="eyebrow"><span>◆</span> MIDI → OPEN NOTE BLOCK STUDIO</div>
        <h1>整批 MIDI<br />直接轉成 <em>NBS</em></h1>
        <p className="lead">拖進來、在瀏覽器裡完成轉換，再一次下載。<br />檔案不會離開你的電腦。</p>

        <div className={`dropzone ${dragging ? "isDragging" : ""} ${items.length ? "hasFiles" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
          onClick={() => fileInput.current?.click()} role="button" tabIndex={0}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") fileInput.current?.click(); }}>
          <input ref={fileInput} type="file" multiple accept=".mid,.midi,.rmi,audio/midi" hidden
            onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
          <input ref={folderInput} type="file" multiple hidden {...directoryProps}
            onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
          <span className="dropIcon" aria-hidden="true"><span>{dragging ? "↓" : items.length ? "✓" : "♪"}</span></span>
          <div>
            <strong>{dragging ? "放開滑鼠，即可加入 MIDI" : items.length ? `已加入 ${items.length.toLocaleString()} 個 MIDI` : "把 MIDI 檔拖到這裡"}</strong>
            <small>{dragging ? "放開後會立即顯示檔案清單" : dropFeedback?.message || "支援 .mid、.midi 與 RMID，可一次加入整批檔案"}</small>
          </div>
          <button type="button" className="selectButton" onClick={(event) => { event.stopPropagation(); fileInput.current?.click(); }}>選擇檔案 <span>↗</span></button>
        </div>
        <p className={`dropFeedback ${dropFeedback?.tone || "idle"}`} aria-live="assertive">
          {dragging ? "已偵測到拖曳中的檔案，現在放開即可加入。" : dropFeedback?.message || "加入後會在下方顯示檔名與數量。"}
        </p>
        <button className="folderButton" type="button" onClick={() => folderInput.current?.click()}>或選擇整個資料夾</button>

        <div className="trustRow" aria-label="轉換特色">
          <span><b>V5</b> 真正 NBS 格式</span><span><b>0–87</b> 完整 NBS 音域</span><span><b>AUTO TPS</b> 精密時序</span><span><b>ZIP</b> 批次下載</span>
        </div>
      </section>

      {items.length > 0 && <section className="workspace" aria-live="polite">
        <header className="workspaceHead">
          <div><p className="sectionLabel">CONVERSION QUEUE</p><h2>{items.length.toLocaleString()} 個 MIDI</h2></div>
          <div className="progressCopy"><b>{counts.done}/{items.length}</b><span>已處理</span></div>
        </header>
        <div className="progressTrack"><i style={{ width: `${items.length ? counts.done / items.length * 100 : 0}%` }} /></div>
        <fieldset className="mappingPanel" disabled={busy}>
          <legend>選擇音高處理方式 <span>不使用直接裁切</span></legend>
          <div className="mappingGrid">
            {pitchModes.map((mode) => <label className={pitchMode === mode.value ? "selected" : ""} aria-label={mode.title} key={mode.value}>
              <input type="radio" name="pitch-mode" value={mode.value} checked={pitchMode === mode.value}
                onChange={() => {
                  setPitchMode(mode.value);
                  invalidateResults();
                }} />
              <span><b>{mode.title}{mode.recommended && <em>建議</em>}</b><small>{mode.description}</small></span>
            </label>)}
          </div>
          <p>高還原模式也會保留 MIDI 音量、expression、左右聲道與 note-on pitch bend。打擊樂維持 NoteBlockStudio drum key，不套用旋律升降八度。</p>
        </fieldset>
        <fieldset className="timingPanel" disabled={busy}>
          <legend>時間精度</legend>
          <div>
            {timingModes.map((mode) => <label className={timingMode === mode.value ? "selected" : ""} aria-label={mode.title} key={mode.value}>
              <input type="radio" name="timing-mode" value={mode.value} checked={timingMode === mode.value}
                onChange={() => { setTimingMode(mode.value); invalidateResults(); }} />
              <span><b>{mode.title}</b><small>{mode.description}</small></span>
            </label>)}
          </div>
        </fieldset>
        <div className="fileList">
          {items.map((item) => <article className={`fileRow ${item.status}`} key={item.id}>
            <span className="statusDot" aria-label={item.status} />
            <div className="fileName"><b>{item.relativeName}</b><small>{item.error || (item.stats ? `${item.stats.totalNotes.toLocaleString()} notes · ${item.stats.layers} layers · ${item.stats.ticksPerSecond.toFixed(2)} TPS${item.stats.warnings.length ? ` · ${item.stats.warnings.length} warnings` : ""}` : `${(item.file.size / 1024).toFixed(1)} KB`)}</small></div>
            {item.status === "success" && <button type="button" onClick={() => downloadOne(item)}>下載 .nbs</button>}
          </article>)}
        </div>
        <footer className="actions">
          <button className="ghostButton" type="button" disabled={busy} onClick={() => { setItems([]); knownFileIds.current.clear(); setDropFeedback(null); }}>清空</button>
          <button className="convertButton" type="button" disabled={busy} onClick={convertAll}>{busy ? `轉換中 ${counts.done}/${items.length}` : "開始本機轉換"}</button>
          <button className="zipButton" type="button" disabled={busy || !counts.success} onClick={downloadAll}>下載全部 ZIP</button>
        </footer>
      </section>}

      <section className="how">
        <p className="sectionLabel">HOW IT WORKS</p>
        <div className="steps">
          <article><span>01</span><h2>加入 MIDI</h2><p>多選、拖放或選擇整個資料夾。</p></article>
          <article><span>02</span><h2>本機轉換</h2><p>解析 tempo、GM 樂器、打擊與音高。</p></article>
          <article><span>03</span><h2>下載 NBS</h2><p>單檔下載，或連同 JSON 摘要打包 ZIP。</p></article>
        </div>
        <p className="formatNote">輸出為未壓縮 Open Note Block Studio v5 binary，不是重新命名的 NBT。NBS v6 尚未納入本地參考版本。</p>
      </section>
    </main>
  );
}
