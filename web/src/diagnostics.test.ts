import { describe, expect, it } from "vitest";
import { CallHistory } from "./diagnostics";
import { installWebMcp, type ModelContext } from "./webmcp";
import type { ToolResult, NotebookToolInvoker } from "./notebook-tools";

const success: ToolResult = {
  content: [],
  structuredContent: {},
  isError: false,
};
describe("memory-only WebMCP diagnostics", () => {
  it("keeps the last ten calls and applies bounded capacity immediately", async () => {
    const history = new CallHistory();
    for (let i = 0; i < 12; i++)
      await history.record(`tool${i}`, async () => success);
    expect(history.snapshot().map((row) => row.tool)).toEqual(
      Array.from({ length: 10 }, (_, i) => `tool${i + 2}`),
    );
    history.setLimit(2);
    expect(history.snapshot().map((row) => row.tool)).toEqual([
      "tool10",
      "tool11",
    ]);
    for (const value of [0, 101, NaN, 2.5])
      expect(() => history.setLimit(value)).toThrow();
    history.clear();
    expect(history.snapshot()).toEqual([]);
    expect(new CallHistory().limit).toBe(10);
  });
  it("tracks running and failed calls without retaining errors or result payloads", async () => {
    const history = new CallHistory();
    let finish!: (result: ToolResult) => void;
    const pending = history.record(
      "query",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(history.snapshot()[0]?.status).toBe("running");
    finish({
      ...success,
      isError: true,
      content: [{ type: "text", text: "SECRET notebook content" }],
    });
    await pending;
    expect(history.snapshot()[0]?.status).toBe("failed");
    expect(JSON.stringify(history.snapshot())).not.toContain("SECRET");
    await expect(
      history.record("execute", async () => {
        throw new Error("SECRET token");
      }),
    ).rejects.toThrow();
    expect(history.snapshot()[1]?.status).toBe("failed");
    expect(JSON.stringify(history.snapshot())).not.toContain("SECRET");
  });
  it("does not resurrect evicted or cleared in-flight entries", async () => {
    const history = new CallHistory();
    history.setLimit(1);
    let finish!: (result: ToolResult) => void;
    const pending = history.record(
      "old",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await history.record("new", async () => success);
    finish(success);
    await pending;
    expect(history.snapshot().map((row) => row.tool)).toEqual(["new"]);
    history.clear();
    expect(history.snapshot()).toEqual([]);
  });
  it("observes the registered WebMCP handler without changing its command path", async () => {
    const history = new CallHistory();
    let handler!: (input: unknown) => Promise<ToolResult>;
    let received: unknown;
    const context: ModelContext = {
      registerTool: (tool) => {
        handler = tool.execute;
      },
    };
    const tools: NotebookToolInvoker = {
      listTools: () => [
        {
          name: "notebook_query",
          description: "Query",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
            required: [],
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
      callTool: async (_name: string, input: unknown) => {
        received = input;
        return success;
      },
    };
    const registration = await installWebMcp(tools, context, history);
    const input = { code: "SECRET", token: "SECRET" };
    expect(await handler(input)).toBe(success);
    expect(received).toBe(input);
    expect(history.snapshot()[0]?.tool).toBe("notebook_query");
    expect(JSON.stringify(history.snapshot())).not.toContain("SECRET");
    registration.dispose();
  });
});
