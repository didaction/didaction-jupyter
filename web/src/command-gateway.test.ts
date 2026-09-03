import { describe, expect, it } from "vitest";
import {
  CommandGateway,
  createQueuedNotebookDispatcher,
} from "./command-gateway";
import { MockNotebookTransport } from "./gateway-client";
import type { CommandResult, NotebookCommand, WasmApplication } from "./types";

describe("CommandGateway", () => {
  it("never rebases an absolute position onto a reordered notebook", async () => {
    const observed: unknown[] = [];
    const wasm: WasmApplication = {
      prepareCommand: (value) => {
        observed.push(JSON.parse(value).expected_revision);
        return value;
      },
      applyCommandResult: (value) => value,
      publicSnapshot: () => "{}",
      dispose() {},
    };
    const transport = new MockNotebookTransport((command) => ({
      protocol_version: 1,
      command_id: command.command_id,
      idempotency_key: command.idempotency_key,
    }));
    const dispatch = createQueuedNotebookDispatcher(
      new CommandGateway(wasm, transport),
      () => 9,
    );
    const command = {
      protocol_version: 1,
      command_id: "one",
      idempotency_key: "one",
      timeout_ms: 1000,
      type: "modify_cells",
      expected_revision: 2,
      changes: [{ operation: "insert", index: 1 }],
    };
    await dispatch(JSON.stringify(command));
    expect(observed).toEqual([2]);
    await expect(
      dispatch(JSON.stringify({ ...command, expected_revision: null })),
    ).rejects.toThrow("require expected_revision");
  });
  it("notifies the host of renames only after successful reconciliation", async () => {
    const order: string[] = [];
    let fail = false;
    const wasm: WasmApplication = {
      prepareCommand: (value) => value,
      applyCommandResult: (value) => {
        order.push("reconciled");
        return value;
      },
      publicSnapshot: () => "{}",
      dispose: () => {},
    };
    const transport = new MockNotebookTransport((command) => ({
      protocol_version: 1,
      command_id: command.command_id,
      idempotency_key: command.idempotency_key,
      ...(fail
        ? {
            error: {
              code: "transport_error",
              message: "Rename failed",
              retryable: true,
            },
          }
        : {}),
    }));
    const dispatch = createQueuedNotebookDispatcher(
      new CommandGateway(wasm, transport),
      () => 0,
      (command) => order.push(`committed:${command.path}`),
    );
    const command = JSON.stringify({
      protocol_version: 1,
      command_id: "rename",
      idempotency_key: "rename",
      type: "rename_notebook",
      path: "renamed.ipynb",
      timeout_ms: 1000,
    });
    await dispatch(command);
    expect(order).toEqual(["reconciled", "committed:renamed.ipynb"]);
    fail = true;
    order.length = 0;
    await dispatch(command);
    expect(order).toEqual(["reconciled"]);
  });
  it("uses one validation and transport path", async () => {
    const calls: string[] = [];
    const wasm: WasmApplication = {
      prepareCommand: (value) => {
        calls.push("prepare");
        return value;
      },
      applyCommandResult: (value) => {
        calls.push("apply");
        return value;
      },
      publicSnapshot: () => "{}",
      dispose: () => {},
    };
    const result: CommandResult = {
      protocol_version: 1,
      command_id: "00000000-0000-0000-0000-000000000001",
      idempotency_key: "one",
    };
    const transport = new MockNotebookTransport((command) => {
      calls.push(command.type);
      return result;
    });
    const gateway = new CommandGateway(wasm, transport);
    await gateway.execute(
      JSON.stringify({
        protocol_version: 1,
        command_id: result.command_id,
        idempotency_key: "one",
        timeout_ms: 1000,
        type: "query",
      }),
    );
    expect(calls).toEqual(["prepare", "query", "apply"]);
  });

  it("serializes egui commands and rebases only after each commit", async () => {
    let revision = 1;
    let active = 0;
    let maximumActive = 0;
    const observedRevisions: unknown[] = [];
    const wasm: WasmApplication = {
      prepareCommand: (value) => value,
      applyCommandResult: (value) => {
        revision += 1;
        return value;
      },
      publicSnapshot: () => JSON.stringify({ snapshot: { revision } }),
      dispose: () => {},
    };
    const result: CommandResult = {
      protocol_version: 1,
      command_id: "00000000-0000-0000-0000-000000000001",
      idempotency_key: "one",
    };
    const transport = new MockNotebookTransport(async (command) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      observedRevisions.push(command.expected_revision);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ...result, command_id: command.command_id };
    });
    const dispatch = createQueuedNotebookDispatcher(
      new CommandGateway(wasm, transport),
      () => revision,
    );
    const makeCommand = (id: string): NotebookCommand => ({
      protocol_version: 1,
      command_id: id,
      idempotency_key: id,
      expected_revision: 0,
      timeout_ms: 1000,
      type: "query",
    });

    await Promise.all([
      dispatch(
        JSON.stringify(makeCommand("00000000-0000-0000-0000-000000000001")),
      ),
      dispatch(
        JSON.stringify(makeCommand("00000000-0000-0000-0000-000000000002")),
      ),
    ]);

    expect(maximumActive).toBe(1);
    expect(observedRevisions).toEqual([1, 2]);
  });

  it("forwards execution progress without committing it as the final result", async () => {
    const applied: string[] = [];
    const progress: string[] = [];
    const wasm: WasmApplication = {
      prepareCommand: (value) => value,
      applyCommandResult: (value) => {
        applied.push(value);
        return value;
      },
      publicSnapshot: () => "{}",
      dispose: () => {},
    };
    const intermediate: CommandResult = {
      protocol_version: 1,
      command_id: "00000000-0000-0000-0000-000000000003",
      idempotency_key: "stream",
      snapshot: { protocol_version: 1, revision: 2, cells: [] },
    };
    const final: CommandResult = {
      ...intermediate,
      snapshot: { protocol_version: 1, revision: 3, cells: [] },
    };
    const transport = new MockNotebookTransport(() => final);
    transport.execute = async (_command, onProgress) => {
      onProgress?.(intermediate);
      return final;
    };
    const gateway = new CommandGateway(wasm, transport);

    await gateway.execute(
      JSON.stringify({
        protocol_version: 1,
        command_id: final.command_id,
        idempotency_key: "stream",
        timeout_ms: 1000,
        type: "execute_cell",
      }),
      (result) => progress.push(JSON.stringify(result)),
    );

    expect(progress).toEqual([JSON.stringify(intermediate)]);
    expect(applied).toEqual([JSON.stringify(final)]);
  });
});
