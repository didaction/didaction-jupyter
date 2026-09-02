import { expect, test } from "@playwright/test";

test("workspace explorer opens notebooks without redirecting another tab", async ({
  page,
  context,
}) => {
  test.skip(
    !process.env.DIDACTION_BROWSER_GATEWAY,
    "Requires isolated gateway",
  );
  const config = await (await page.request.get("/api/v1/config")).json();
  const other = "explorer-second.ipynb";
  const result = await page.request.post("/api/v1/commands", {
    headers: { "x-notebook-path": other },
    data: {
      protocol_version: 1,
      command_id: crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      type: "setup",
      path: other,
      kernel: config.kernel,
      create: true,
      timeout_ms: 30000,
    },
  });
  expect((await result.json()).error).toBeNull();
  await page.goto("/");
  await expect(page.locator("#connection-status")).toContainText("Connected", {
    timeout: 60000,
  });
  await expect(
    page.getByRole("button", { name: other, exact: true }),
  ).toBeVisible();
  const second = await context.newPage();
  await second.goto(`/?notebook=${encodeURIComponent(other)}`);
  await expect(second.locator("#connection-status")).toContainText(
    "Connected",
    { timeout: 60000 },
  );
  const request = {
    protocol_version: 1,
    command_id: crypto.randomUUID(),
    idempotency_key: crypto.randomUUID(),
    type: "query",
    query: "full",
    timeout_ms: 30000,
  };
  const firstQuery = await page.request.post("/api/v1/commands", {
    headers: { "x-notebook-path": config.path },
    data: request,
  });
  expect((await firstQuery.json()).snapshot.notebook.path).toBe(config.path);
  await page.getByRole("button", { name: other, exact: true }).click();
  await expect(page).toHaveURL(/notebook=explorer-second.ipynb/);
  await expect(page.locator("#connection-status")).toContainText("Connected", {
    timeout: 60000,
  });
  await expect(page.locator("#notebook-files [aria-current]")).toContainText(
    other,
  );
  expect(
    (
      await page.request.get("/api/v1/notebooks?directory=..%2Foutside")
    ).status(),
  ).toBe(400);
  await page.screenshot({ path: ".impeccable/review/desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole("button", {
    name: "Toggle workspace explorer",
  });
  await toggle.click();
  await expect(page.locator("#file-explorer")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: ".impeccable/review/mobile.png" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#file-explorer")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});
