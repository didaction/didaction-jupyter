import { defineConfig } from "@playwright/test";

/** Runs the real egui/WebMCP kernel scenario from production static files only. */
export default defineConfig({
  testDir: "tests/browser-kernel",
  testMatch: ["runtime.spec.ts", "graphics.spec.ts"],
  grep: /real JupyterLite worker through egui|real browser compiler animates/,
  timeout: 60_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:43176", trace: "off" },
  webServer: {
    command:
      "pnpm exec vite preview --mode browser --host 127.0.0.1 --port 43176 --strictPort --outDir ../dist-browser",
    url: "http://127.0.0.1:43176",
    reuseExistingServer: false,
  },
});
