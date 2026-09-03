import type { KernelEvent } from "./browser-kernel";

export type Output =
  | { kind: "text"; text: string }
  | { kind: "stream"; name: string; text: string }
  | { kind: "error"; name: string; message: string; traceback: string[] }
  | { kind: "rich"; mime: string; data: string };
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Malformed kernel output");
  if (new TextEncoder().encode(value).length > 512 * 1024)
    throw new Error("Kernel output exceeds limit");
  return value;
};
function display(bundle: Record<string, unknown>): Output {
  const data = bundle.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object")
    throw new Error("Malformed display output");
  for (const mime of ["image/png", "image/svg+xml", "text/html"])
    if (typeof data[mime] === "string") {
      const value = text(data[mime]);
      return {
        kind: "rich",
        mime,
        data:
          mime === "image/svg+xml"
            ? btoa(
                Array.from(new TextEncoder().encode(value), (byte) =>
                  String.fromCharCode(byte),
                ).join(""),
              )
            : value,
      };
    }
  return {
    kind: "text",
    text: text(data["text/plain"] ?? "[Unsupported display format]"),
  };
}
/** Copy-on-write reducer: failed/malformed events leave the prior outputs intact. */
export class OutputReducer {
  outputs: Output[] = [];
  private displayIds: (string | undefined)[] = [];
  private clearNext = false;
  apply(event: KernelEvent): void {
    const bundle = event.bundle ?? {};
    if (event.type === "clear_output") {
      if (bundle.wait === true) this.clearNext = true;
      else {
        this.outputs = [];
        this.displayIds = [];
        this.clearNext = false;
      }
      return;
    }
    if (
      ![
        "stream",
        "display_data",
        "update_display_data",
        "execute_result",
        "execute_error",
      ].includes(event.type)
    )
      return;
    const outputs = this.clearNext ? [] : structuredClone(this.outputs);
    const ids = this.clearNext ? [] : [...this.displayIds];
    const id = (bundle.transient as { display_id?: string } | undefined)
      ?.display_id;
    let output: Output;
    if (event.type === "stream") {
      const name = text(bundle.name);
      if (!["stdout", "stderr"].includes(name))
        throw new Error("Malformed stream name");
      output = { kind: "stream", name, text: text(bundle.text) };
      const previous = outputs.at(-1);
      if (previous?.kind === "stream" && previous.name === name) {
        output.text = text(previous.text + output.text);
        outputs.pop();
        ids.pop();
      }
    } else if (event.type === "execute_error") {
      if (!Array.isArray(bundle.traceback) || bundle.traceback.length > 64)
        throw new Error("Malformed traceback");
      output = {
        kind: "error",
        name: text(bundle.ename),
        message: text(bundle.evalue),
        traceback: bundle.traceback.map(text),
      };
    } else output = display(bundle);
    if (event.type === "update_display_data") {
      if (id)
        ids.forEach((value, index) => {
          if (value === id) outputs[index] = output;
        });
    } else {
      outputs.push(output);
      ids.push(id);
    }
    if (
      outputs.length > 128 ||
      new TextEncoder().encode(JSON.stringify(outputs)).length > 3_000_000
    )
      throw new Error("Notebook output exceeds limit");
    this.outputs = outputs;
    this.displayIds = ids;
    this.clearNext = false;
  }
}
