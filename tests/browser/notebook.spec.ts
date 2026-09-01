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
