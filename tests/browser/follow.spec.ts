import { expect, test, type Page } from "@playwright/test";

async function installTools(page: Page) {
  await page.addInitScript(() => {
    const tools: Record<string, { execute(input: unknown): Promise<unknown> }> =
      {};
    Object.defineProperty(document, "modelContext", {
      configurable: true,
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
    Object.assign(window, { followTestTools: tools });
  });
}
async function call(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
) {
  return page.evaluate(
    async ({ name, args }) => {
      const tools = (
        window as unknown as {
          followTestTools: Record<
            string,
            {
              execute(input: unknown): Promise<{
                isError: boolean;
                structuredContent: Record<string, unknown>;
              }>;
            }
          >;
        }
      ).followTestTools;
      return tools[name]!.execute(args);
    },
    { name, args },
  );
}

test("opt-in follows actual egui scroll and notebook switches; opt-out stays independent", async ({
  page,
  context,
}) => {
  test.skip(
    !process.env.DIDACTION_BROWSER_GATEWAY,
    "Requires isolated real gateway",
  );
  const config = await (await page.request.get("/api/v1/config")).json();
  const names = [
    `follow-a-${crypto.randomUUID()}.ipynb`,
    `follow-b-${crypto.randomUUID()}.ipynb`,
  ];
  for (const notebook of names) {
    const member = await (
      await page.request.post("/api/v1/collaboration/join", {
        headers: { "x-notebook-path": notebook },
      })
    ).json();
    const headers = {
      "x-notebook-path": notebook,
      "x-notebook-client": member.token,
    };
    const send = async (type: string, values: Record<string, unknown>) =>
      (
        await page.request.post("/api/v1/commands", {
          headers,
          data: {
            protocol_version: 1,
            command_id: crypto.randomUUID(),
            idempotency_key: crypto.randomUUID(),
            timeout_ms: 30000,
            type,
            ...values,
          },
        })
      ).json();
    expect(
      (
        await send("setup", {
          path: notebook,
          kernel: config.kernel,
          create: true,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await send("modify_cells", {
          changes: [
            {
              operation: "insert",
              index: 0,
              cell: {
                id: "long-note",
                cell_type: "markdown",
                source: Array.from(
                  { length: 60 },
                  (_, i) =>
                    `## Section ${i}\n\nFollow this notebook's reading position.\n`,
                ).join("\n"),
                metadata: {},
                execution_count: null,
                outputs: [],
              },
            },
          ],
        })
      ).error,
    ).toBeNull();
    await page.request.post("/api/v1/collaboration/leave", { headers });
  }
  await installTools(page);
  await page.goto(`/?notebook=${names[0]}`);
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
    { timeout: 60000 },
  );
  const observer = await context.newPage();
  await installTools(observer);
  await observer.goto(`/?notebook=${names[0]}`);
  await expect(observer.locator("#connection-status")).toContainText(
    "WebMCP ready",
    { timeout: 60000 },
  );
  await expect(observer.locator("#follow-driver")).toBeEnabled();
  await expect(page.locator("#follow-driver")).toBeDisabled();
  const scroll = async (target: Page) =>
    Number(
      (
        (await call(target, "get_active_context")).structuredContent
          .context as { scroll_fraction: number }
      ).scroll_fraction,
    );
  await page
    .locator("#notebook-canvas")
    .hover({ position: { x: 400, y: 350 } });
  await page.mouse.wheel(0, 2400);
  await expect.poll(() => scroll(page)).toBeGreaterThan(0.2);
  expect(await scroll(observer)).toBeLessThan(0.01);
  await observer.locator("#follow-driver").click();
  await expect
    .poll(async () => Math.abs((await scroll(page)) - (await scroll(observer))))
    .toBeLessThan(0.02);
  expect(
    (await call(page, "open_notebook", { notebook_path: names[1] })).isError,
  ).toBe(false);
  await expect(observer).toHaveURL(new RegExp(names[1]!));
  await page
    .locator("#notebook-canvas")
    .hover({ position: { x: 400, y: 350 } });
  await page.mouse.wheel(0, 1900);
  await expect.poll(() => scroll(page)).toBeGreaterThan(0.1);
  await expect
    .poll(async () => Math.abs((await scroll(page)) - (await scroll(observer))))
    .toBeLessThan(0.02);
  await observer.screenshot({ path: ".runtime/follow-desktop.png" });
  await observer.setViewportSize({ width: 520, height: 720 });
  await expect
    .poll(async () => Math.abs((await scroll(page)) - (await scroll(observer))))
    .toBeLessThan(0.03);
  await observer.screenshot({ path: ".runtime/follow-mobile.png" });
  await observer.locator("#follow-driver").click();
  const independentPosition = await scroll(observer);
  expect(
    (await call(page, "open_notebook", { notebook_path: names[0] })).isError,
  ).toBe(false);
  await page.mouse.wheel(0, 1800);
  await page.waitForTimeout(1000);
  expect(Math.abs((await scroll(observer)) - independentPosition)).toBeLessThan(
    0.01,
  );
  await expect(observer).toHaveURL(new RegExp(names[1]!));
  await expect(observer.locator("#follow-driver")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
