"use client";

import { useMemo, useRef, useState, type InputHTMLAttributes } from "react";
import { parseMidi } from "../lib/midi";
import { convertMidiToNbs, type NbsStats } from "../lib/nbs";
import { makeZip } from "../lib/zip";

type Status = "ready" | "processing" | "success" | "error";
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
  const [busy, setBusy] = useState(false);
  const [minecraftMode, setMinecraftMode] = useState(true);

  const counts = useMemo(() => ({
    success: items.filter((item) => item.status === "success").length,
    error: items.filter((item) => item.status === "error").length,
    done: items.filter((item) => item.status === "success" || item.status === "error").length,
  }), [items]);

  function addFiles(files: Iterable<File>) {
    const accepted = [...files].filter((file) => /\.(mid|midi|rmi)$/i.test(file.name));
    setItems((current) => {
      const seen = new Set(current.map((item) => item.id));
      const additions = accepted.flatMap((file) => {
        const relativeName = file.webkitRelativePath || file.name;
        const id = `${relativeName}\0${file.size}\0${file.lastModified}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{ id, file, relativeName, status: "ready" as const }];
      });
      return [...current, ...additions];
    });
  }

  async function convertAll() {
    if (busy || !items.length) return;
    setBusy(true);
    const working = items.map((item) => ({ ...item, status: "ready" as Status, bytes: undefined, stats: undefined, error: undefined }));
    setItems(working);
    for (let index = 0; index < working.length; index++) {
      working[index] = { ...working[index], status: "processing" };
      setItems([...working]);
      try {
        const midi = parseMidi(await working[index].file.arrayBuffer(), outputName(working[index].file.name).replace(/\.nbs$/i, ""));
        const result = convertMidiToNbs(midi, working[index].file.name, { foldToVanillaRange: minecraftMode });
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
      generatedAt: new Date().toISOString(), format: "Open Note Block Studio v5", tempo: 10,
      minecraftMelodyMode: minecraftMode, filesFound: items.length, succeeded: successes.length,
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

        <div className={`dropzone ${dragging ? "isDragging" : ""}`}
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
          <span className="dropIcon" aria-hidden="true"><span>♪</span></span>
          <div><strong>把 MIDI 檔拖到這裡</strong><small>支援 .mid、.midi 與 RMID，可一次加入整批檔案</small></div>
          <button type="button" className="selectButton" onClick={(event) => { event.stopPropagation(); fileInput.current?.click(); }}>選擇檔案 <span>↗</span></button>
        </div>
        <button className="folderButton" type="button" onClick={() => folderInput.current?.click()}>或選擇整個資料夾</button>

        <div className="trustRow" aria-label="轉換特色">
          <span><b>V5</b> 真正 NBS 格式</span><span><b>16</b> 種原版樂器</span><span><b>10 TPS</b> 100 ms 時序</span><span><b>ZIP</b> 批次下載</span>
        </div>
      </section>

      {items.length > 0 && <section className="workspace" aria-live="polite">
        <header className="workspaceHead">
          <div><p className="sectionLabel">CONVERSION QUEUE</p><h2>{items.length.toLocaleString()} 個 MIDI</h2></div>
          <div className="progressCopy"><b>{counts.done}/{items.length}</b><span>已處理</span></div>
        </header>
        <div className="progressTrack"><i style={{ width: `${items.length ? counts.done / items.length * 100 : 0}%` }} /></div>
        <label className="modeToggle" htmlFor="minecraft-mode" aria-label="原版 Minecraft 旋律相容模式">
          <input id="minecraft-mode" type="checkbox" checked={minecraftMode} disabled={busy} onChange={(event) => setMinecraftMode(event.target.checked)} />
          <span><b>原版 Minecraft 旋律相容模式</b><small>旋律以樂器重映射／八度轉調維持 NBS key 33–57；打擊樂保留 NoteBlockStudio 官方 drum key。</small></span>
        </label>
        <div className="fileList">
          {items.map((item) => <article className={`fileRow ${item.status}`} key={item.id}>
            <span className="statusDot" aria-label={item.status} />
            <div className="fileName"><b>{item.relativeName}</b><small>{item.error || (item.stats ? `${item.stats.totalNotes.toLocaleString()} notes · ${item.stats.layers} layers${item.stats.warnings.length ? ` · ${item.stats.warnings.length} warnings` : ""}` : `${(item.file.size / 1024).toFixed(1)} KB`)}</small></div>
            {item.status === "success" && <button type="button" onClick={() => downloadOne(item)}>下載 .nbs</button>}
          </article>)}
        </div>
        <footer className="actions">
          <button className="ghostButton" type="button" disabled={busy} onClick={() => setItems([])}>清空</button>
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
