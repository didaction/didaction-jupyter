import { build } from "esbuild";
import { cp, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
if (!existsSync("web/public/xeus/didaction-xeus/xpython/kernel.json")) {
  console.log(
    "Optional xeus runtime not prepared; keeping Pyodide-only build.",
  );
  process.exit(0);
}
const result = await build({
  entryPoints: ["web/src/xeus-kernel.worker.ts"],
  outfile: "web/public/xeus/worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  alias: { "@emscripten-forge/mambajs": "./web/src/xeus-install-disabled.ts" },
});
// Upstream's unpacker resolves its binary relative to the classic worker URL.
for (const directory of new Set(
  Object.keys(result.metafile.inputs)
    .filter((path) => path.includes("mambajs-core/"))
    .map(dirname),
)) {
  for (const file of await readdir(directory)) {
    if (file.endsWith(".wasm"))
      await cp(join(directory, file), join("web/public/xeus", file));
  }
}
