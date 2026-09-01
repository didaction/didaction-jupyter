import { describe, expect, it } from "vitest";
import { CommandGateway } from "./command-gateway";
import { MockNotebookTransport } from "./mcp-client";
import type { CommandResult, WasmApplication } from "./types";

describe("CommandGateway", () => {
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
});
