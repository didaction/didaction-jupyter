import { chromium } from "@playwright/test";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    process.env.DIDACTION_GATEWAY_URL ?? "http://127.0.0.1:45173",
  );
  await page
    .locator("#connection-status")
    .filter({ hasText: "Connected" })
    .waitFor({ timeout: 60000 });
  if (await page.locator("#fatal-error").isVisible())
    throw new Error("Notebook startup failed");
  if (errors.length) throw new Error("Browser runtime errors");
  await page.screenshot({ path: ".runtime/container-notebook.png" });
  console.log("container browser: WASM mounted, connected, no runtime errors");
} finally {
  await browser.close();
}
