import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { initSync } from "../pkg/notebook_wasm";
import { OutputReducer } from "./browser-outputs";
import { browserPath } from "./browser-store";

beforeAll(() => {
  initSync({
    module: readFileSync(
      new URL("../pkg/notebook_wasm_bg.wasm", import.meta.url),
    ),
  });
});

describe("browser output protocol reducer", () => {
  it("streams in order and coalesces same-channel text", () => {
    const reducer = new OutputReducer();
    reducer.apply({ type: "stream", bundle: { name: "stdout", text: "one" } });
    reducer.apply({ type: "stream", bundle: { name: "stdout", text: "two" } });
    expect(reducer.outputs).toEqual([
      { kind: "stream", name: "stdout", text: "onetwo" },
    ]);
  });
  it("preserves old output until the next output when clear_output(wait=True)", () => {
    const reducer = new OutputReducer();
    reducer.apply({ type: "stream", bundle: { name: "stdout", text: "old" } });
    reducer.apply({ type: "clear_output", bundle: { wait: true } });
    expect(JSON.stringify(reducer.outputs)).toContain("old");
    reducer.apply({ type: "stream", bundle: { name: "stdout", text: "new" } });
    expect(JSON.stringify(reducer.outputs)).not.toContain("old");
    reducer.apply({ type: "clear_output", bundle: { wait: false } });
    expect(reducer.outputs).toEqual([]);
  });
  it("replaces display IDs instead of appending stale results", () => {
    const reducer = new OutputReducer();
    reducer.apply({
      type: "display_data",
      bundle: { data: { "text/plain": "old" }, transient: { display_id: "x" } },
    });
    reducer.apply({
      type: "update_display_data",
      bundle: { data: { "text/plain": "new" }, transient: { display_id: "x" } },
    });
    expect(reducer.outputs).toEqual([{ kind: "text", text: "new" }]);
  });
  it("prioritizes supported rich outputs and rejects malformed/bounded output atomically", () => {
    const reducer = new OutputReducer();
    reducer.apply({
      type: "display_data",
      bundle: { data: { "image/png": "YWJj", "text/plain": "fallback" } },
    });
    const before = structuredClone(reducer.outputs);
    expect(before).toEqual([{ kind: "rich", mime: "image/png", data: "YWJj" }]);
    expect(() =>
      reducer.apply({ type: "stream", bundle: { name: "stdout", text: {} } }),
    ).toThrow();
    expect(() =>
      reducer.apply({
        type: "stream",
        bundle: { name: "stdout", text: "a".repeat(524289) },
      }),
    ).toThrow();
    expect(reducer.outputs).toEqual(before);
  });
  it("never treats widget comm messages as output", () => {
    const reducer = new OutputReducer();
    reducer.apply({ type: "comm_open", bundle: {} });
    expect(reducer.outputs).toEqual([]);
  });
  it("confines browser notebook paths", () => {
    for (const path of [
      "/etc/a.ipynb",
      "../a.ipynb",
      "a/../b.ipynb",
      "a\\b.ipynb",
      "https://x/a.ipynb",
      "a%2fb.ipynb",
      "a.txt",
    ])
      expect(() => browserPath(path)).toThrow();
    expect(browserPath("examples/demo.ipynb")).toBe("examples/demo.ipynb");
    expect(browserPath("", true)).toBe("");
  });
});
