import { describe, expect, it, vi } from "vitest";
import { NotebookTools } from "./notebook-tools";
import { installWebMcp, type ModelContext } from "./webmcp";
import {
  CommandGateway,
  createQueuedNotebookDispatcher,
} from "./command-gateway";
import { MockNotebookTransport } from "./gateway-client";
import type { NotebookSnapshot, WasmApplication } from "./types";

function harness() {
  let snapshot: NotebookSnapshot = {
    protocol_version: 1,
    revision: 1,
    cells: [
      {
        id: "one",
        cell_type: "code",
        source: "value = 40",
        metadata: {},
        execution_count: null,
        outputs: [],
      },
    ],
  };
  const calls: Record<string, unknown>[] = [];
  let validations = 0;
  const wasm: WasmApplication = {
    prepareCommand: (input) => {
      validations++;
      return input;
    },
    applyCommandResult: (input) => {
      snapshot = JSON.parse(input).snapshot;
      return input;
    },
    publicSnapshot: () => JSON.stringify({ snapshot }),
    dispose() {},
  };
  const gateway = new CommandGateway(
    wasm,
    new MockNotebookTransport((command) => {
      calls.push(command);
      const cells = snapshot.cells as Record<string, unknown>[];
      for (const change of (command.changes ?? []) as Record<
        string,
        unknown
      >[]) {
        const at = cells.findIndex((cell) => cell.id === change.cell_id);
        switch (change.operation) {
          case "insert":
            cells.splice(
              change.index as number,
              0,
              change.cell as Record<string, unknown>,
            );
            break;
          case "insert_relative": {
            const anchor = cells.findIndex(
              (cell) => cell.id === change.anchor_cell_id,
            );
            cells.splice(
              anchor + (change.after ? 1 : 0),
              0,
              change.cell as Record<string, unknown>,
            );
            break;
          }
          case "update":
            if (change.source !== undefined) cells[at]!.source = change.source;
            if (change.metadata !== undefined)
              cells[at]!.metadata = change.metadata;
            break;
          case "delete":
            cells.splice(at, 1);
            break;
          case "move":
            cells.splice(change.index as number, 0, cells.splice(at, 1)[0]!);
            break;
          case "clear_outputs":
            cells[at]!.outputs = [];
            break;
        }
      }
      if (command.type === "execute_cell")
        cells.find((cell) => cell.id === command.cell_id)!.outputs = [
          { kind: "text", text: "42" },
        ];
      return {
        protocol_version: 1,
        command_id: command.command_id,
        idempotency_key: command.idempotency_key,
        snapshot: { ...snapshot, revision: snapshot.revision + 1 },
      };
    }),
  );
  const dispatch = createQueuedNotebookDispatcher(
    gateway,
    () => snapshot.revision,
  );
  const tools = new NotebookTools(dispatch.transaction, () => snapshot);
  return { tools, calls, dispatch, count: () => validations };
}
describe("transport-neutral notebook tools", () => {
  it("requires an unambiguous positional intent and forwards ID anchors", async () => {
    const h = harness();
    for (const position of [
      {},
      { index: 0, before_cell_id: "one" },
      { before_cell_id: "one", after_cell_id: "one" },
    ]) {
      expect(
        (
          await h.tools.callTool("insert_cell", {
            ...position,
            cell_type: "markdown",
            source: "note",
          })
        ).isError,
      ).toBe(true);
    }
    expect(h.calls).toHaveLength(0);
    expect(
      (
        await h.tools.callTool("insert_cell", {
          before_cell_id: "one",
          cell_type: "markdown",
          source: "note",
        })
      ).isError,
    ).toBe(false);
    expect(h.calls.at(-1)?.changes).toMatchObject([
      { operation: "insert_relative", anchor_cell_id: "one", after: false },
    ]);
  });
  it("marks only code immediately following Markdown and preserves metadata", async () => {
    const h = harness();
    const inserted = await h.tools.callTool("insert_cell", {
      before_cell_id: "one",
      cell_type: "markdown",
      source: "# Explanation",
    });
    expect(inserted.isError).toBe(false);
    const markdownCellId = inserted.structuredContent.cell_id as string;
    expect(
      (
        await h.tools.callTool("set_markdown_code_group", {
          cell_id: "one",
          grouped: true,
        })
      ).isError,
    ).toBe(false);
    expect(h.calls.at(-1)?.changes).toEqual([
      {
        operation: "update",
        cell_id: "one",
        metadata: {
          didaction_markdown_group: {
            schema_version: 1,
            markdown_cell_id: markdownCellId,
          },
        },
      },
    ]);
    const read = await h.tools.callTool("read_cell", { cell_id: "one" });
    expect(read.structuredContent.cell).toMatchObject({
      id: "one",
      markdown_grouped: true,
      source: "value = 40",
    });
    expect(
      (
        await h.tools.callTool("set_markdown_code_group", {
          cell_id: "one",
          grouped: false,
        })
      ).isError,
    ).toBe(false);
    expect(h.calls.at(-1)?.changes).toEqual([
      { operation: "update", cell_id: "one", metadata: {} },
    ]);
  });
  it("routes bounded agent highlights through the view validator, never kernel commands", async () => {
    const view = vi.fn(async () => ({
      content: [],
      structuredContent: { ok: true },
      isError: false,
    }));
    const transaction = vi.fn();
    const tools = new NotebookTools(
      transaction,
      () => ({ protocol_version: 1, revision: 1, cells: [] }),
      undefined,
      undefined,
      view,
    );
    expect(
      (
        await tools.callTool("highlight_cell", {
          cell_id: "one",
          color: "blue-light",
        })
      ).isError,
    ).toBe(false);
    expect(
      (await tools.callTool("clear_cell_highlight", { cell_id: "one" }))
        .isError,
    ).toBe(false);
    expect(
      (await tools.callTool("highlight_cell", { cell_id: "one", color: "red" }))
        .isError,
    ).toBe(true);
    expect(view).toHaveBeenCalledTimes(2);
    expect(transaction).not.toHaveBeenCalled();
  });
  it("maps the complete cell workflow through command validation", async () => {
    const h = harness();
    const inserted = await h.tools.callTool("insert_cell", {
      index: 1,
      cell_type: "code",
      source: "value",
    });
    const cell_id = inserted.structuredContent.cell_id;
    for (const [name, args] of [
      ["overwrite_cell_source", { cell_id, source: "value + 1" }],
      ["edit_cell_source", { cell_id, old_string: "+ 1", new_string: "+ 2" }],
      ["move_cell", { cell_id, index: 0 }],
      ["execute_cell", { cell_id }],
      ["clear_cell_output", { cell_id }],
      ["read_cell", { cell_id }],
      ["delete_cell", { cell_id }],
      ["insert_execute_code_cell", { index: 0, source: "42" }],
      ["restart_notebook", {}],
      ["interrupt_kernel", {}],
      ["read_notebook", {}],
    ] as const)
      expect((await h.tools.callTool(name, args)).isError, name).toBe(false);
    expect(h.count()).toBe(h.calls.length);
    expect(h.calls.map((c) => c.type)).toContain("execute_cell");
  });
  it("rejects malformed/unbounded/envelope injection before dispatch", async () => {
    const h = harness();
    for (const input of [
      { cell_id: "one", type: "setup" },
      { cell_id: "one", timeout_ms: 120001 },
      { cell_id: "x".repeat(129) },
      null,
    ]) {
      expect((await h.tools.callTool("execute_cell", input)).isError).toBe(
        true,
      );
    }
    expect((await h.tools.callTool("call_mcp", {})).isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
  it("blocks ambiguous edits and installation magics", async () => {
    const h = harness();
    expect(
      (
        await h.tools.callTool("edit_cell_source", {
          cell_id: "one",
          old_string: "missing",
          new_string: "x",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await h.tools.callTool("insert_execute_code_cell", {
          index: 0,
          source: "%pip install danger",
        })
      ).isError,
    ).toBe(true);
    expect(h.calls.every((c) => c.type === "query")).toBe(true);
  });
  it("WebMCP discovers and invokes the same catalog, then unregisters", async () => {
    const h = harness();
    const registered: Parameters<ModelContext["registerTool"]>[0][] = [];
    const removed: string[] = [];
    const installed = await installWebMcp(h.tools, {
      registerTool: (tool) => {
        registered.push(tool);
      },
      unregisterTool: (name) => {
        removed.push(name);
      },
    });
    expect(installed.available).toBe(true);
    expect(registered).toHaveLength(33);
    expect(
      (
        await registered
          .find((tool) => tool.name === "read_cell")!
          .execute({ cell_id: "one" })
      ).isError,
    ).toBe(false);
    expect(h.calls).toHaveLength(1);
    installed.dispose();
    expect(removed).toHaveLength(33);
    expect((await installWebMcp(h.tools, {} as ModelContext)).available).toBe(
      false,
    );
  });
  it("discovers document.modelContext and awaits async registration with abort cleanup", async () => {
    const signals: AbortSignal[] = [];
    let completed = 0;
    vi.stubGlobal("document", {
      modelContext: {
        async registerTool(_tool: unknown, options: { signal: AbortSignal }) {
          await Promise.resolve();
          completed++;
          signals.push(options.signal);
        },
      },
    });
    try {
      const installed = await installWebMcp(harness().tools);
      expect(installed.available).toBe(true);
      expect(completed).toBe(33);
      installed.dispose();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("cleans up when asynchronous registration rejects", async () => {
    let signal: AbortSignal | undefined;
    const installed = await installWebMcp(harness().tools, {
      async registerTool(_tool, options) {
        signal = options?.signal;
        throw new Error("registration failed");
      },
    });
    expect(installed.available).toBe(false);
    expect(signal?.aborted).toBe(true);
  });
  it("serializes compound tool calls with human commands", async () => {
    const h = harness();
    await Promise.all([
      h.tools.callTool("insert_execute_code_cell", { index: 0, source: "42" }),
      h.dispatch(
        JSON.stringify({
          protocol_version: 1,
          command_id: crypto.randomUUID(),
          idempotency_key: "human",
          timeout_ms: 1000,
          type: "query",
          query: "full",
        }),
      ),
    ]);
    expect(h.calls.map((call) => call.type)).toEqual([
      "query",
      "modify_cells",
      "execute_cell",
      "query",
    ]);
  });
});
