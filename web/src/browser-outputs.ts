import { reduceKernelOutput } from "../pkg/notebook_wasm";
import type { KernelEvent } from "./browser-kernel";

export type Output =
  | { kind: "text"; text: string }
  | { kind: "stream"; name: string; text: string }
  | { kind: "error"; name: string; message: string; traceback: string[] }
  | { kind: "rich"; mime: string; data: string };

/** Native and browser hosts share Rust output semantics, not parallel reducers. */
export class OutputReducer {
  outputs: Output[] = [];
  private state = '{"outputs":[],"display_ids":[],"clear_next":false}';
  apply(event: KernelEvent): void {
    const next = reduceKernelOutput(this.state, JSON.stringify(event));
    this.outputs = JSON.parse(next).outputs as Output[];
    this.state = next;
  }
}
