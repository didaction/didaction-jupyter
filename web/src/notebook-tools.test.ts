import { describe, expect, it } from "vitest";
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
          case "update":
            cells[at]!.source = change.source;
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
    const installed = installWebMcp(h.tools, {
      registerTool: (tool) => {
        registered.push(tool);
      },
      unregisterTool: (name) => {
        removed.push(name);
      },
    });
    expect(installed.available).toBe(true);
    expect(registered).toHaveLength(12);
    expect(
      (
        await registered
          .find((tool) => tool.name === "read_cell")!
          .execute({ cell_id: "one" })
      ).isError,
    ).toBe(false);
    expect(h.calls).toHaveLength(1);
    installed.dispose();
    expect(removed).toHaveLength(12);
    expect(installWebMcp(h.tools, {} as ModelContext).available).toBe(false);
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
