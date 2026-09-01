import { expect, test } from "@playwright/test";

test("WASM mounts a credential-free notebook shell with fallback", async ({
  page,
}) => {
  const secrets: string[] = [];
  page.on("console", (message) => secrets.push(message.text()));
  await page.goto("/");
  await expect(page.locator("#notebook-canvas")).toBeVisible();
  await expect(page.locator("#connection-status")).toContainText(
    /Connected|Disconnected/,
    { timeout: 30_000 },
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-webmcp",
    /available|unavailable/,
  );
  const exposed = await page.evaluate(
    () =>
      `${document.documentElement.innerHTML}${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`,
  );
  expect(exposed).not.toMatch(/authorization|mcp-session-id|jupyter.*token/i);
  expect(secrets.join("\n")).not.toMatch(
    /authorization|mcp-session-id|jupyter.*token/i,
  );
});

test("notebook canvas follows window resizing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const canvas = page.locator("#notebook-canvas");
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const desktop = await canvas.boundingBox();
  expect(desktop).not.toBeNull();
  expect(desktop!.width).toBe(1280);
  expect(desktop!.y + desktop!.height).toBeLessThanOrEqual(900);

  await page.setViewportSize({ width: 520, height: 640 });
  await expect
    .poll(async () => canvas.boundingBox())
    .toMatchObject({ width: 520 });
  const compact = await canvas.boundingBox();
  expect(compact).not.toBeNull();
  expect(compact!.height).toBeLessThan(desktop!.height);
  expect(compact!.y + compact!.height).toBeLessThanOrEqual(640);

  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight,
  );
  expect(pageOverflow).toBe(false);
});

test("notebook canvas follows host panel resizing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const shell = page.locator("#notebook-shell");
  const canvas = page.locator("#notebook-canvas");
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  await shell.evaluate((element) => {
    element.style.width = "720px";
  });
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(720);

  await expect
    .poll(async () =>
      canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return Math.abs(
          canvas.width - canvas.clientWidth * window.devicePixelRatio,
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  const metrics = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return {
      clientWidth: canvas.clientWidth,
      backingWidth: canvas.width,
      pixelRatio: window.devicePixelRatio,
    };
  });
  expect(metrics.backingWidth).toBeCloseTo(
    metrics.clientWidth * metrics.pixelRatio,
    0,
  );
});
