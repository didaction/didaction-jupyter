import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
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
