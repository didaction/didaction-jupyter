import { NotebookApplication } from "../pkg/notebook_wasm";
import type { CollaborationState } from "./collaboration";
import { IndexedNotebookStore } from "./browser-store";
import { BrowserNotebookTransport } from "./browser-transport";
import { WorkerKernel } from "./browser-kernel";
import { BrowserArtifactTransport } from "./browser-artifacts";

/** Explicit single-user policy, not a simulated collaboration server. */
export class LocalNotebookConnection {
  state: CollaborationState;
  constructor(path: string) {
    this.state = {
      notebook_path: path,
      client_id: "browser-local",
      driver_id: "browser-local",
      is_driver: true,
      clients: ["browser-local"],
      sequence: 0,
      origin: null,
      snapshot: null,
    };
  }
  join = async () => {};
  close = async () => {};
  publish = async () => {};
  headers = () => ({});
  rename = (path: string) => {
    this.state.notebook_path = path;
  };
  watch = async (
    receive: (state: CollaborationState) => void,
    _failure: () => void,
  ) => {
    receive(this.state);
  };
  subscribe = () => () => {};
  changeDriver = async () => {
    throw new Error(
      "Browser mode is single-user; driver handoff requires server mode",
    );
  };
  setDriverPermission = async (_action: "claim" | "release") => {
    throw new Error("Browser mode is local-only");
  };
}
export class BrowserWorkspace {
  kernelName: "pyodide" | "xeus-python" = "pyodide";
  readonly store = new IndexedNotebookStore();
  readonly artifacts = new BrowserArtifactTransport(this.store);
  private release?: () => void;
  async acquire(): Promise<void> {
    if (!navigator.locks)
      throw new Error("Browser workspace requires Web Locks support");
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(
          "didaction-browser-workspace",
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(
                new Error(
                  "Browser workspace is open in another tab. Close that tab first; collaboration is available in server mode.",
                ),
              );
              return;
            }
            await new Promise<void>((release) => {
              this.release = release;
              resolve();
            });
          },
        )
        .catch(reject);
    });
  }
  transport(path: string): BrowserNotebookTransport {
    return new BrowserNotebookTransport(
      path,
      this.store,
      new WorkerKernel(
        async () => ({
          files: await this.store.artifacts(),
          directory: path.split("/").slice(0, -1).join("/"),
        }),
        this.kernelName,
      ),
      (snapshot) => new NotebookApplication(snapshot),
      this.kernelName,
    );
  }
  close(): void {
    this.release?.();
  }
}
