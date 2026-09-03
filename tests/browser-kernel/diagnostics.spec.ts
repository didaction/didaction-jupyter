import { test, expect } from "@playwright/test";

test("status-bar diagnostics show WASM provenance and memory-only bounded WebMCP history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const tools: Record<string, { execute(input: unknown): Promise<unknown> }> =
      {};
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool(tool: {
          name: string;
          execute(input: unknown): Promise<unknown>;
        }) {
          tools[tool.name] = tool;
        },
        unregisterTool(name: string) {
          delete tools[name];
        },
      },
    });
    Object.assign(window, { diagnosticTestTools: tools });
  });
  await page.goto("/?runtime=browser");
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
  );
  await expect(page.locator(".privacy-note")).toHaveCount(0);
  const panel = page.locator("#diagnostics-panel");
  await expect(panel).toBeHidden();
  await page.waitForTimeout(200);
  const canvas = await page.locator("#notebook-canvas").boundingBox();
  await page.mouse.click(canvas!.x + 16, canvas!.y + canvas!.height - 16);
  await expect(panel).toBeVisible();
  await expect(page.locator("#wasm-git-sha")).toHaveText(/^[a-f0-9]{40}$/);
  await expect(page.locator("#diagnostics-empty")).toBeVisible();
  await page.evaluate(async () => {
    const tools = (
      window as unknown as {
        diagnosticTestTools: Record<
          string,
          { execute(input: unknown): Promise<unknown> }
        >;
      }
    ).diagnosticTestTools;
    for (let i = 0; i < 12; i++) await tools.get_active_context!.execute({});
    // Rejected input must not leak into the diagnostics panel.
    await tools.get_active_context!.execute({ unknown: "SECRET-CONTENT" });
  });
  await expect(page.locator("#diagnostics-calls li")).toHaveCount(10);
  await expect(panel).not.toContainText("SECRET-CONTENT");
  await expect(page.locator("#diagnostics-calls li").first()).toContainText(
    "failed",
  );
  await page.locator("#diagnostics-limit").fill("3");
  await page.locator("#diagnostics-limit").press("Tab");
  await expect(page.locator("#diagnostics-calls li")).toHaveCount(3);
  await page.screenshot({ path: ".runtime/diagnostics-desktop.png" });
  for (const width of [739, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `.runtime/diagnostics-${width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.locator("#diagnostics-close").click();
  await expect(panel).toBeHidden();
  await page.reload();
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
  );
  // Accessible equivalent to the canvas icon.
  await page.locator("#diagnostics-toggle").focus();
  await page.locator("#diagnostics-toggle").press("Enter");
  await expect(panel).toBeVisible();
  await expect(page.locator("#diagnostics-calls li")).toHaveCount(0);
  await expect(page.locator("#diagnostics-limit")).toHaveValue("10");
  await page.locator("#diagnostics-close").press("Escape");
  await expect(panel).toBeHidden();
});
