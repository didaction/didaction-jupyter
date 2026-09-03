import { defineConfig } from "vite";

export const runtimeConfig = (mode: string) => ({
  root: "web",
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
