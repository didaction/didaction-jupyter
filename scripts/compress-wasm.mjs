import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const source = new URL("../web/pkg/notebook_wasm_bg.wasm", import.meta.url);
const destination = new URL(
  "../web/pkg/notebook_wasm_bg.wasm.gzipdata",
  import.meta.url,
);
const wasm = await readFile(source);

await writeFile(destination, gzipSync(wasm, { level: 9 }));

const bindingsPath = new URL("../web/pkg/notebook_wasm.js", import.meta.url);
const bindings = await readFile(bindingsPath, "utf8");
const wasmUrl = "new URL('notebook_wasm_bg.wasm', import.meta.url)";
const compressedUrl =
  "new URL('notebook_wasm_bg.wasm.gzipdata', import.meta.url)";
const plainFetch = "module_or_path = fetch(module_or_path);";
const compressedFetch = `module_or_path = fetch(module_or_path).then(async (response) => {
            if (!response.ok || !response.body) throw new Error(\`Unable to load notebook runtime (\${response.status})\`);
            return new Response(response.body.pipeThrough(new DecompressionStream('gzip')), {
                headers: { 'Content-Type': 'application/wasm' },
            });
        });`;

if (bindings.includes(wasmUrl) && bindings.includes(plainFetch)) {
  await writeFile(
    bindingsPath,
    bindings
      .replace(wasmUrl, compressedUrl)
      .replace(plainFetch, compressedFetch),
  );
} else if (!bindings.includes(compressedUrl)) {
  throw new Error("Unable to locate wasm-bindgen loader markers");
}
