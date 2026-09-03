import { expect, test } from "@playwright/test";
import {
  installMicroscopeTools,
  microscopeCall,
} from "../fixtures/microscope-tools";
import { waveGraphics } from "../fixtures/graphics";
test("browser compiler worker produces a module", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (source) => {
    const worker = new Worker("/src/graphics-compiler.worker.ts", {
      type: "module",
    });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.terminate();
        resolve("timeout");
      }, 10000);
      worker.onerror = (e) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(e.message);
      };
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(data.error ?? data.binary instanceof Uint8Array);
      };
      worker.postMessage({ source });
    });
  }, waveGraphics.source);
  expect(result).toBe(true);
});

test("real browser compiler animates egui graphics, resizes, tears down, recovers from traps and hangs", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await installMicroscopeTools(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open demo workspace" }).click();
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
  );
  const cell = { notebook_path: "browser-demo.ipynb", cell_id: "browser-plot" };
  const walkthrough = {
    title: "Waves",
    steps: [
      {
        id: "waves",
        title: "Two waves, one phase",
        code: "sin(x - t)\ncos(x - t)",
        markdown: "Sine and cosine share a frequency, but differ in phase.",
        graphics: waveGraphics,
        playground_code: "print(40 + 2)",
      },
      {
        id: "empty",
        title: "No graphics",
        code: "42",
        markdown: "The previous runtime has been destroyed.",
      },
    ],
  };
  const created = await microscopeCall(page, "create_microscope", {
    ...cell,
    title: "Waves",
    walkthrough,
  });
  expect(created.isError).toBe(false);
  const scope = {
    ...cell,
    microscope_id: created.structuredContent.microscope_id,
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    microscopeCall(page, name, { ...scope, ...args });
  await call("open_microscope");
  const status = async () => {
    const context = (await microscopeCall(page, "get_active_context"))
      .structuredContent.context as {
      walkthrough: {
        graphics: {
          frames: number;
          width: number;
          paused: boolean;
          error: string | null;
        } | null;
      };
    };
    return context.walkthrough.graphics;
  };
  await expect
    .poll(
      async () => {
        const s = await status();
        expect(s?.error).toBeFalsy();
        return s?.frames ?? 0;
      },
      { timeout: 15000 },
    )
    .toBeGreaterThan(3);
  const width = (await status())!.width;
  const canvas = (await page.locator("#notebook-canvas").boundingBox())!;
  await page.mouse.click(canvas.x + 590, canvas.y + 240);
  await expect.poll(async () => (await status())?.paused).toBe(true);
  await page.waitForTimeout(150);
  const pausedFrames = (await status())!.frames;
  await page.waitForTimeout(150);
  expect((await status())!.frames).toBe(pausedFrames);
  await page.mouse.click(canvas.x + 590, canvas.y + 240);
  await expect
    .poll(async () => (await status())?.frames ?? 0)
    .toBeGreaterThan(pausedFrames);
  await page.screenshot({ path: ".runtime/graphics-desktop.png" });
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => (await status())?.width).toBeLessThan(width);
  await page.screenshot({ path: ".runtime/graphics-narrow.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await status())?.paused).toBe(true);
  await page.waitForTimeout(150);
  const reducedFrames = (await status())!.frames;
  await page.waitForTimeout(150);
  expect((await status())!.frames).toBe(reducedFrames);
  await page.screenshot({ path: ".runtime/graphics-reduced-motion.png" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect((await call("open_playground", { step_index: 0 })).isError).toBe(
    false,
  );
  await expect(page.locator("#playground-canvas")).toBeVisible();
  await expect
    .poll(
      () => page.workers().filter((w) => w.url().includes("graphics")).length,
    )
    .toBe(0);
  expect(
    (
      await microscopeCall(page, "execute_playground", {
        notebook_path: cell.notebook_path,
      })
    ).isError,
  ).toBe(false);
  const playground = await microscopeCall(page, "read_playground", {
    notebook_path: cell.notebook_path,
  });
  expect(JSON.stringify(playground.structuredContent.snapshot)).toContain("42");
  await microscopeCall(page, "close_playground", {
    notebook_path: cell.notebook_path,
  });
  await expect
    .poll(async () => (await status())?.frames ?? 0, { timeout: 15000 })
    .toBeGreaterThan(2);
  await call("focus_microscope_step", { step_index: 1 });
  await expect.poll(status).toBeNull();
  await expect
    .poll(
      () => page.workers().filter((w) => w.url().includes("graphics")).length,
    )
    .toBe(0);
  await call("focus_microscope_step", { step_index: 0 });
  await expect
    .poll(async () => (await status())?.frames ?? 0, { timeout: 45000 })
    .toBeGreaterThan(2);
  for (const body of [
    "unreachable();",
    "while(true) {}",
    "this is invalid syntax",
  ]) {
    const next = structuredClone(walkthrough);
    next.steps[0]!.graphics!.source = waveGraphics.source.replace(
      "return changetype<usize>(pixels);",
      body,
    );
    expect(
      (await call("update_microscope", { walkthrough: next })).isError,
    ).toBe(false);
    await expect
      .poll(async () => (await status())?.error, { timeout: 45000 })
      .toBeTruthy();
    if (body === "unreachable();")
      await page.screenshot({ path: ".runtime/graphics-error.png" });
    expect(
      (await call("focus_microscope_step", { step_index: 1 })).isError,
    ).toBe(false);
    await call("focus_microscope_step", { step_index: 0 });
  }
  await call("update_microscope", { walkthrough });
  await expect
    .poll(async () => (await status())?.frames ?? 0, { timeout: 45000 })
    .toBeGreaterThan(2);
});
