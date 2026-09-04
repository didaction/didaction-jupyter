import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const browserSkills = (): import("vite").Plugin => ({
  name: "browser-skills-guide",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use("/SKILLS.md", (_request, response) => {
      response.setHeader("Content-Type", "text/markdown; charset=utf-8");
      response.setHeader(
        "Content-Disposition",
        'attachment; filename="SKILLS.md"',
      );
      response.end(readFileSync("SKILLS.md", "utf8"));
    });
  },
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "SKILLS.md",
      source: readFileSync("SKILLS.md", "utf8"),
    });
  },
});

export const runtimeConfig = (mode: string) => ({
  root: "web",
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: mode === "browser" ? [browserSkills()] : [],
  // Only browser builds ship Python assets. Server deployment cannot opt into
  // browser kernels by URL or runtime environment variables.
  publicDir: mode === "browser" ? "public" : (false as const),
  define: {
    "import.meta.env.VITE_NOTEBOOK_RUNTIME": JSON.stringify(
      mode === "browser" ? "browser" : "server",
    ),
  },
  build: {
    outDir: mode === "browser" ? "../dist-browser" : "../dist",
    emptyOutDir: true,
  },
  worker: { format: "es" as const },
  // Discover lazy worker dependencies before serving. Adding the compiler after
  // boot otherwise invalidates optimized chunks and reloads/disposes notebooks.
  optimizeDeps: {
    include: [
      "assemblyscript/asc",
      ...(mode === "browser" ? ["@jupyterlite/pyodide-kernel/lib/worker"] : []),
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy:
      mode === "browser"
        ? undefined
        : {
            // Keep the browser's Host aligned with Origin for the gateway's origin guard.
            "/api": { target: "http://127.0.0.1:8080", changeOrigin: false },
            "/readyz": { target: "http://127.0.0.1:8080", changeOrigin: false },
          },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});

export default defineConfig(({ mode }) => runtimeConfig(mode));
