import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  timeout: 120_000,
  use: {
    baseURL: process.env.DIDACTION_BROWSER_GATEWAY ?? "http://127.0.0.1:43173",
    trace: "retain-on-failure",
  },
  webServer: process.env.DIDACTION_BROWSER_GATEWAY
    ? undefined
    : {
        command:
          "pnpm run build && python3 -m http.server 43173 --bind 127.0.0.1 --directory dist",
        url: "http://127.0.0.1:43173",
        reuseExistingServer: false,
      },
});
