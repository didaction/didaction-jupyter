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
