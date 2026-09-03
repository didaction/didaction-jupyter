import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser-kernel",
  timeout: 60_000,
  globalTimeout: 120_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:43175", trace: "off" },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 43175 --strictPort",
    url: "http://127.0.0.1:43175",
    reuseExistingServer: false,
  },
});
