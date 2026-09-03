import { browserPath } from "./browser-store";

export interface WorkspaceEntry {
  path: string;
  directory: boolean;
  bytes: Uint8Array;
}
export const ZIP_LIMIT = 20_000_000;
export const ENTRY_LIMIT = 1_000_000;
export const COUNT_LIMIT = 1000;
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Narrow ZIP reader: stored/deflate only, bounded streaming inflation, no host extraction. */
export async function readWorkspaceZip(
  buffer: ArrayBuffer,
): Promise<WorkspaceEntry[]> {
  if (buffer.byteLength > ZIP_LIMIT || buffer.byteLength < 22)
    throw new Error("ZIP must be at most 20 MB.");
  const view = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  const fail = () =>
    new Error(
      "Invalid or unsupported ZIP. Use an unencrypted ZIP with UTF-8 names and stored/deflate entries.",
    );
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    view.getUint32(end, true) !== 0x06054b50
  )
    end--;
  if (end < Math.max(0, bytes.length - 65557)) throw fail();
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  const central = offset;
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count > COUNT_LIMIT ||
    offset + size !== end ||
    end + 22 + view.getUint16(end + 20, true) !== bytes.length
  )
    throw fail();
  const entries: WorkspaceEntry[] = [],
    names = new Set<string>();
  let total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw fail();
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true),
      compressed = view.getUint32(offset + 20, true),
      length = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true),
      extra = view.getUint16(offset + 30, true),
      comment = view.getUint16(offset + 32, true);
    const mode = view.getUint32(offset + 38, true) >>> 16,
      local = view.getUint32(offset + 42, true);
    if (
      offset + 46 + nameLength + extra + comment > end ||
      flags & ~0x080e ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      (mode & 0xf000) === 0xa000 ||
      view.getUint16(offset + 34, true) ||
      length > ENTRY_LIMIT ||
      total + length > ZIP_LIMIT
    )
      throw fail();
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x800) && nameBytes.some((b) => b > 127)) throw fail();
    const name = decoder.decode(nameBytes),
      directory = name.endsWith("/"),
      path = directory ? name.slice(0, -1) : name;
    browserPath(path, true);
    if (!path || names.has(path))
      throw new Error("ZIP contains an empty or duplicate path.");
    names.add(path);
    if (
      local + 30 > central ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 6, true) !== flags
    )
      throw fail();
    const localName = view.getUint16(local + 26, true),
      start = local + 30 + localName + view.getUint16(local + 28, true);
    if (
      start + compressed > central ||
      decoder.decode(bytes.slice(local + 30, local + 30 + localName)) !== name
    )
      throw fail();
    let output: Uint8Array;
    if (method === 0) output = bytes.slice(start, start + compressed);
    else {
      const reader = new Blob([bytes.slice(start, start + compressed)])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"))
        .getReader();
      const parts: Uint8Array[] = [];
      let actual = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          actual += next.value.length;
          if (actual > length || actual > ENTRY_LIMIT)
            throw new Error("ZIP expansion exceeds its declared size.");
          parts.push(next.value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      }
      output = new Uint8Array(actual);
      let position = 0;
      for (const part of parts) {
        output.set(part, position);
        position += part.length;
      }
    }
    if (
      output.length !== length ||
      crc32(output) !== crc ||
      (directory && length !== 0)
    )
      throw fail();
    total += output.length;
    entries.push({ path, directory, bytes: output });
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) throw fail();
  return entries;
}
