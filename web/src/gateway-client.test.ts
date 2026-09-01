import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayNotebookTransport } from "./gateway-client";
import type { CommandResult, NotebookCommand } from "./types";

describe("GatewayNotebookTransport streaming", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("delivers each NDJSON execution snapshot before returning the idle final", async () => {
    const encoder = new TextEncoder();
    const revisions = [2, 3, 3];
    const states = ["busy", "busy", "idle"];
    const events = revisions.map((revision, index) => ({
      protocol_version: 1,
      command_id: "00000000-0000-0000-0000-000000000001",
      idempotency_key: "stream",
      snapshot: {
        protocol_version: 1,
        revision,
        cells: [],
        kernel: { state: states[index] },
      },
    })) satisfies CommandResult[];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const command: NotebookCommand = {
      protocol_version: 1,
      command_id: events[0]!.command_id,
      idempotency_key: "stream",
      timeout_ms: 1000,
      type: "execute_cell",
    };
    const progress: number[] = [];

    const final = await new GatewayNotebookTransport().execute(
      command,
      (event) => progress.push(event.snapshot?.revision ?? -1),
    );

    expect(progress).toEqual([2, 3, 3]);
    expect(final.snapshot?.kernel).toEqual({ state: "idle" });
  });
});
