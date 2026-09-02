import { expect, test } from "@playwright/test";

const snapshot = {
  protocol_version: 1,
  schema_version: 1,
  notebook: { path: "notebook-parity-demo.ipynb", workspace: "local" },
  kernel: {
    name: "python3",
    display_name: "Python 3 (ipykernel)",
    session_id: null,
    state: "idle",
  },
  revision: 1,
  cells: [
    {
      id: "markdown",
      cell_type: "markdown",
      source: "# Browser acceptance\n\nRendered **CommonMark**.",
      metadata: {},
      execution_count: null,
      outputs: [],
    },
    {
      id: "code",
      cell_type: "code",
      source: "value = 40 + 2\nvalue",
      metadata: {},
      execution_count: 1,
      outputs: [{ kind: "text", text: "42" }],
    },
  ],
  selected_cell_id: "code",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/config", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        path: "notebook-parity-demo.ipynb",
        kernel: "python3",
      }),
    });
  });
  await page.route("**/api/v1/commands", async (route) => {
    const request = route.request().postDataJSON() as {
      command_id: string;
      idempotency_key: string;
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        command_id: request.command_id,
        idempotency_key: request.idempotency_key,
        base_revision: null,
        committed_revision: 1,
        snapshot,
      }),
    });
  });
});

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
  expect(desktop!.width).toBe(1280 - 248);
  expect(desktop!.y + desktop!.height).toBeLessThanOrEqual(900);

  await page.setViewportSize({ width: 520, height: 640 });
  await expect
    .poll(async () => canvas.boundingBox())
    .toMatchObject({ width: 520 - 180 });
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
    element.style.flex = "none";
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
