import { expect, test } from "@playwright/test";

test("Python 3.12 scientific baseline is preloaded without runtime downloads", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1")
      externalRequests.push(url.href);
  });
  await page.goto("/");
  await expect(page.locator("#browser-launch")).toBeVisible();
  const result = await page.evaluate(async () => {
    const { WorkerKernel } = await import(String("/src/browser-kernel.ts"));
    const kernel = new WorkerKernel(undefined, "pyodide-027");
    const events: unknown[] = [];
    await kernel.request(
      "execute",
      [
        "import sys, micropip",
        "import numpy, scipy, pandas, matplotlib, networkx, sympy",
        "print(sys.version_info[:2])",
        "print(numpy.__version__, scipy.__version__, pandas.__version__)",
      ].join("\n"),
      0,
      60_000,
      (event: unknown) => events.push(event),
    );
    kernel.close();
    return events;
  });
  expect(JSON.stringify(result)).toContain("(3, 12)");
  expect(externalRequests).toEqual([]);
});

test("real JupyterLite worker through egui/WebMCP: execute, plot, persist and restart", async ({
  page,
  context,
}) => {
  const gatewayRequests: string[] = [];
  const externalRequests: string[] = [];
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) gatewayRequests.push(url.pathname);
    if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1")
      externalRequests.push(url.href);
  });
  await page.addInitScript(() => {
    const tools: Record<string, { execute(args: unknown): Promise<unknown> }> =
      {};
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool(tool: {
          name: string;
          execute(args: unknown): Promise<unknown>;
        }) {
          tools[tool.name] = tool;
        },
        unregisterTool(name: string) {
          delete tools[name];
        },
      },
    });
    Object.assign(window, { testNotebookTools: tools });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open demo workspace" }).click();
  await expect(page.locator("#connection-status")).toContainText(
    "Browser kernel",
  );
  await expect(page.locator("#notebook-canvas")).toBeVisible();
  const call = (name: string, args: Record<string, unknown> = {}) =>
    page.evaluate(
      async ({ name, args }) => {
        const tools = (
          window as unknown as {
            testNotebookTools: Record<
              string,
              {
                execute(args: unknown): Promise<{
                  isError: boolean;
                  structuredContent: Record<string, unknown>;
                }>;
              }
            >;
          }
        ).testNotebookTools;
        return tools[name]!.execute({
          notebook_path: "browser-demo.ipynb",
          ...args,
        });
      },
      { name, args },
    );
  const first = await call("insert_execute_code_cell", {
    index: 0,
    source: "browser_value = 40 + 2\nbrowser_value",
  });
  expect(first, JSON.stringify(first)).toMatchObject({ isError: false });
  expect(JSON.stringify(first)).toContain("42");
  const firstId = first.structuredContent.cell_id as string;
  // Exercise the human editor and toolbar play button, then read via WebMCP.
  // egui consumes input on animation frames, not synchronously in DOM handlers.
  await page.waitForTimeout(150);
  await page.mouse.click(430, 231);
  await page.waitForTimeout(100);
  await page.keyboard.press("ControlOrMeta+A");
  await page.waitForTimeout(100);
  await page.keyboard.insertText("browser_value = 44; browser_value");
  await page.waitForTimeout(100);
  // Finish the editor transaction before an agent reads the notebook.
  await page.mouse.click(270, 141);
  await page.waitForTimeout(300);
  await page.mouse.click(447, 141);
  await page.waitForTimeout(300);
  await page.screenshot({ path: ".runtime/browser-human-probe.png" });
  await expect
    .poll(async () =>
      JSON.stringify(await call("read_cell", { cell_id: firstId })),
    )
    .toContain('"text":"44"');
  const plot = await call("insert_execute_code_cell", {
    index: 1,
    source:
      "import matplotlib.pyplot as plt\nplt.bar(['a', 'b'], [2, 4])\nplt.show()",
  });
  expect(plot, JSON.stringify(plot)).toMatchObject({ isError: false });
  const plotId = plot.structuredContent.cell_id as string;
  expect(
    JSON.stringify(await call("read_cell", { cell_id: plotId })),
  ).toContain("image/png");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(100);
  await page.screenshot({
    path: ".runtime/browser-kernel-egui.png",
    fullPage: true,
  });
  expect(gatewayRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(consoleMessages.join("\n")).not.toContain("browser_value =");

  const other = await context.newPage();
  await other.goto("/");
  await expect(other.locator("#fatal-error")).toContainText("another tab");
  await other.close();

  await page.reload();
  await expect(page.locator("#connection-status")).toContainText(
    "Browser kernel",
  );
  expect(
    JSON.stringify(await call("read_cell", { cell_id: plotId })),
  ).toContain("image/png");
  const lost = await call("insert_execute_code_cell", {
    index: 2,
    source: "browser_value",
  });
  expect(JSON.stringify(lost)).toContain("NameError");
});

test("real worker protocol streams intermediate clear/display updates, completes, inspects and interrupts", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Open demo workspace" }).click();
  await expect(page.locator("#connection-status")).toContainText(
    "Browser kernel",
  );
  const result = await page.evaluate(async () => {
    const { WorkerKernel } = await import(String("/src/browser-kernel.ts"));
    const { OutputReducer } = await import(String("/src/browser-outputs.ts"));
    const kernel = new WorkerKernel();
    const reducer = new OutputReducer();
    const intermediate: string[] = [];
    const code =
      "import asyncio\nfrom IPython.display import display, clear_output\nprint('phase-one')\nawait asyncio.sleep(0.2)\nclear_output(wait=True)\nhandle = display('phase-two', display_id=True)\nawait asyncio.sleep(0.2)\nhandle.update('phase-three')";
    await kernel.request(
      "execute",
      code,
      0,
      30000,
      (event: import("../../web/src/browser-kernel").KernelEvent) => {
        reducer.apply(event);
        intermediate.push(JSON.stringify(reducer.outputs));
      },
    );
    const completion = await kernel.request("complete", "str.up", 6, 30000);
    const inspection = await kernel.request("inspect", "len", 3, 30000);
    const errors: string[] = [];
    const running = kernel.request(
      "execute",
      "while True:\n    pass",
      0,
      15000,
      (event: unknown) => errors.push(JSON.stringify(event)),
    );
    setTimeout(() => kernel.interrupt(), 1000);
    let interruptFailure = "";
    try {
      await running;
    } catch (error) {
      interruptFailure = String(error);
    }
    await kernel.request("execute", "retained = 42", 0, 30000);
    await kernel.restart();
    const restartEvents: string[] = [];
    await kernel.request("execute", "retained", 0, 30000, (event: unknown) =>
      restartEvents.push(JSON.stringify(event)),
    );
    kernel.close();
    return {
      intermediate,
      final: reducer.outputs,
      completion,
      inspection,
      errors,
      restartEvents,
      interruptFailure,
    };
  });
  expect(
    result.intermediate.some((output: string) => output.includes("phase-one")),
  ).toBe(true);
  expect(
    result.intermediate.some((output: string) => output.includes("phase-two")),
  ).toBe(true);
  expect(JSON.stringify(result.final)).toContain("phase-three");
  expect(JSON.stringify(result.final)).not.toContain("phase-one");
  expect(JSON.stringify(result.final)).not.toContain("phase-two");
  expect(JSON.stringify(result.completion)).toContain("upper");
  expect(result.inspection.found).toBe(true);
  expect(result.errors.join("") + result.interruptFailure).toMatch(
    /KeyboardInterrupt|interrupted.*variables were lost/,
  );
  expect(result.restartEvents.join("")).toContain("NameError");
});
