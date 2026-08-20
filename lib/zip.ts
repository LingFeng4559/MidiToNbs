export type ZipEntry = { name: string; data: Uint8Array };

const encoder = new TextEncoder();
let crcTable: Uint32Array | undefined;

function table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[n] = value >>> 0;
  }
  return crcTable;
}

function crc32(data: Uint8Array) {
  const values = table();
  let crc = 0xffffffff;
  for (const byte of data) crc = values[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function header(length: number) {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

function safeName(name: string) {
  return name.replaceAll("\\", "/").replace(/^\/+/, "").replace(/(^|\/)\.\.(\/|$)/g, "$1_$2");
}

export function makeZip(entries: ZipEntry[]) {
  if (entries.length > 0xffff) throw new Error("ZIP 檔案數超過 65,535");
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(safeName(entry.name));
    const size = entry.data.byteLength;
    if (size > 0xffffffff || offset > 0xffffffff) throw new Error("ZIP 超過 ZIP32 的 4 GB 限制");
    const crc = crc32(entry.data);
    const local = header(30 + name.length);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, size, true);
    local.view.setUint32(22, size, true);
    local.view.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    parts.push(local.bytes, entry.data);

    const record = header(46 + name.length);
    record.view.setUint32(0, 0x02014b50, true);
    record.view.setUint16(4, 20, true);
    record.view.setUint16(6, 20, true);
    record.view.setUint16(8, 0x0800, true);
    record.view.setUint16(10, 0, true);
    record.view.setUint32(16, crc, true);
    record.view.setUint32(20, size, true);
    record.view.setUint32(24, size, true);
    record.view.setUint16(28, name.length, true);
    record.view.setUint32(42, offset, true);
    record.bytes.set(name, 46);
    central.push(record.bytes);
    offset += local.bytes.length + size;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  parts.push(...central);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, centralOffset, true);
  parts.push(end.bytes);
  return new Blob(parts, { type: "application/zip" });
}
