import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const source = new URL("../web/pkg/notebook_wasm_bg.wasm", import.meta.url);
const destination = new URL(
  "../web/pkg/notebook_wasm_bg.wasm.gz",
  import.meta.url,
);
const wasm = await readFile(source);

await writeFile(destination, gzipSync(wasm, { level: 9 }));
