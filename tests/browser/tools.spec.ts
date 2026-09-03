import { expect, test } from "@playwright/test";

test("WebMCP tools load WASM, mutate, execute, refresh and reject injected fields", async ({
  page,
}) => {
  test.skip(
    !process.env.DIDACTION_BROWSER_GATEWAY,
    "Requires an isolated real gateway; run scripts/container-check.sh",
  );
  await page.addInitScript(() => {
    const registered: Record<
      string,
      { execute(input: unknown): Promise<unknown> }
    > = {};
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        async registerTool(tool: {
          name: string;
          execute(input: unknown): Promise<unknown>;
        }) {
          registered[tool.name] = tool;
        },
        unregisterTool(name: string) {
          delete registered[name];
        },
      },
    });
    Object.assign(window, { registeredNotebookTools: registered });
  });
  const config = await (await page.request.get("/api/v1/config")).json();
  const notebook = `tools-${crypto.randomUUID()}.ipynb`;
  const member = await (
    await page.request.post("/api/v1/collaboration/join", {
      headers: { "x-notebook-path": notebook },
    })
  ).json();
  const headers = {
    "x-notebook-path": notebook,
    "x-notebook-client": member.token,
  };
  const setup = await (
    await page.request.post("/api/v1/commands", {
      headers,
      data: {
        protocol_version: 1,
        command_id: crypto.randomUUID(),
        idempotency_key: crypto.randomUUID(),
        type: "setup",
        path: notebook,
        kernel: config.kernel,
        create: true,
        timeout_ms: 30000,
      },
    })
  ).json();
  expect(setup.error).toBeNull();
  await page.request.post("/api/v1/collaboration/leave", { headers });
  await page.goto(`/?notebook=${notebook}`);
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
    { timeout: 60000 },
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    page.evaluate(
      async ({ name, args }) => {
        const tools = (
          window as unknown as {
            registeredNotebookTools: Record<
              string,
              {
                execute(input: unknown): Promise<{
                  isError: boolean;
                  structuredContent: Record<string, unknown>;
                }>;
              }
            >;
          }
        ).registeredNotebookTools;
        return tools[name]!.execute({
          ...(name.startsWith("list_") || name === "get_active_context"
            ? {}
            : {
                notebook_path: new URL(location.href).searchParams.get(
                  "notebook",
                ),
              }),
          ...args,
        });
      },
      { name, args },
    );
  const inserted = await call("insert_execute_code_cell", {
    index: 0,
    source: "webmcp_value = 40 + 2\nwebmcp_value",
  });
  expect(inserted.isError).toBe(false);
  const cell_id = inserted.structuredContent.cell_id as string;
  expect(JSON.stringify(inserted)).toContain("42");
  const anchored = await call("insert_execute_code_cell", {
    before_cell_id: cell_id,
    source: "webmcp_value + 1",
  });
  expect(anchored.isError).toBe(false);
  expect(JSON.stringify(anchored)).toContain("43");
  const anchorId = anchored.structuredContent.cell_id;
  expect(
    (await call("move_cell", { cell_id: anchorId, after_cell_id: cell_id }))
      .isError,
  ).toBe(false);
  const ordered = (await call("read_notebook")).structuredContent.cells as {
    id: string;
  }[];
  expect(ordered.findIndex((cell) => cell.id === anchorId)).toBe(
    ordered.findIndex((cell) => cell.id === cell_id) + 1,
  );
  expect(
    (await call("highlight_cell", { cell_id, color: "blue-deep" })).isError,
  ).toBe(false);
  await page.screenshot({ path: ".runtime/agent-highlight-desktop.png" });
  expect((await call("clear_cell_highlight", { cell_id })).isError).toBe(false);
  expect((await call("delete_cell", { cell_id: anchorId })).isError).toBe(
    false,
  );
  expect(
    (
      await call("insert_cell", {
        before_cell_id: anchorId,
        cell_type: "code",
        source: "must not insert",
      })
    ).isError,
  ).toBe(true);
  expect(
    (await call("set_output_visibility", { cell_id, mode: "windowed" }))
      .isError,
  ).toBe(false);
  expect(
    (await call("set_cell_visibility", { cell_id, collapsed: true })).isError,
  ).toBe(false);
  const folded = await call("capture_cell", { cell_id });
  expect(folded.isError).toBe(false);
  expect(folded.structuredContent.height).toBeGreaterThan(0);
  expect(
    (await call("set_cell_visibility", { cell_id, collapsed: false })).isError,
  ).toBe(false);
  const expanded = await call("capture_cell", { cell_id });
  expect(expanded.isError).toBe(false);
  expect(Number(expanded.structuredContent.height)).toBeGreaterThan(
    Number(folded.structuredContent.height),
  );
  expect(JSON.stringify(await call("read_cell", { cell_id }))).toContain("42");
  expect(
    (
      await call("edit_cell_source", {
        cell_id,
        old_string: "40 + 2",
        new_string: "40 + 3",
      })
    ).isError,
  ).toBe(false);
  expect(JSON.stringify(await call("execute_cell", { cell_id }))).toContain(
    "43",
  );
  expect((await call("move_cell", { cell_id, index: 1 })).isError).toBe(false);
  expect((await call("clear_cell_output", { cell_id })).isError).toBe(false);
  expect(
    (
      await call("execute_cell", {
        cell_id,
        type: "setup",
        path: "/etc/passwd",
      })
    ).isError,
  ).toBe(true);
  await page.screenshot({ path: ".runtime/frontend-tools.png" });
  await page.reload();
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
    { timeout: 60000 },
  );
  expect(JSON.stringify(await call("read_cell", { cell_id }))).toContain(
    "40 + 3",
  );
  expect((await call("delete_cell", { cell_id })).isError).toBe(false);
  expect((await call("read_cell", { cell_id })).isError).toBe(true);
  const sleeping = await call("insert_cell", {
    index: 0,
    cell_type: "code",
    source: "import time\nprint('started', flush=True)\ntime.sleep(20)",
  });
  const sleeper = sleeping.structuredContent.cell_id as string;
  const started = page.waitForResponse((response) =>
    response.url().endsWith("/commands/stream"),
  );
  const began = Date.now();
  const running = call("execute_cell", { cell_id: sleeper });
  await started;
  await page.waitForTimeout(1000); // Allow the kernel to enter sleep before interrupting.
  expect((await call("interrupt_kernel")).isError).toBe(false);
  const interrupted = await running;
  expect(JSON.stringify(interrupted)).toContain("KeyboardInterrupt");
  expect(Date.now() - began).toBeLessThan(15000);
  expect((await call("delete_cell", { cell_id: sleeper })).isError).toBe(false);
  const notebook_path = new URL(page.url()).searchParams.get("notebook")!;
  const context = (await call("get_active_context")).structuredContent
    .context as Record<string, unknown>;
  expect(context.notebook_path).toBe(notebook_path);
  expect(["edit", "command"]).toContain(context.mode);
  expect(
    (await call("read_notebook", { notebook_path: "not-open.ipynb" })).isError,
  ).toBe(true);
  expect((await call("list_notebooks", { directory: "" })).isError).toBe(false);
  expect(
    (await call("list_open_notebooks")).structuredContent.notebooks,
  ).toHaveLength(1);
  expect((await call("close_notebook", { notebook_path })).isError).toBe(false);
  await expect(page.locator("#notebook-shell")).toBeHidden();
  expect(
    (await call("get_active_context")).structuredContent.context,
  ).toBeNull();
  expect(
    (await call("list_open_notebooks")).structuredContent.notebooks,
  ).toHaveLength(0);
  expect((await call("open_notebook", { notebook_path })).isError).toBe(false);
  await expect(page.locator("#notebook-canvas")).toBeVisible();
  const retained = await call("insert_execute_code_cell", {
    index: 0,
    source: "webmcp_value",
  });
  expect(JSON.stringify(retained)).toContain("43");
  await call("delete_cell", { cell_id: retained.structuredContent.cell_id });
  const publicSurface = await page.evaluate(
    () =>
      document.documentElement.innerHTML +
      JSON.stringify(localStorage) +
      JSON.stringify(sessionStorage),
  );
  expect(publicSurface).not.toMatch(
    /authorization|jupyter_token|mcp-session-id/i,
  );
});
