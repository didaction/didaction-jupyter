import {
  DEFAULT_BROWSER_KERNEL,
  type BrowserKernelName,
} from "./browser-kernel-profile";

export type KernelEvent = { type: string; bundle?: Record<string, unknown> };
export interface BrowserKernel {
  request(
    method: "execute" | "complete" | "inspect",
    code: string,
    cursor: number,
    timeout: number,
    progress?: (event: KernelEvent) => void,
  ): Promise<Record<string, unknown>>;
  interrupt(): void;
  restart(): Promise<void>;
  close(): void;
}
export class WorkerKernel implements BrowserKernel {
  constructor(
    private readonly workspace?: () => Promise<{
      files: { path: string; directory: boolean; bytes: Uint8Array }[];
      directory: string;
    }>,
    private readonly kernelName: BrowserKernelName = DEFAULT_BROWSER_KERNEL,
  ) {}
  private worker?: Worker;
  private buffer?: Uint8Array;
  private ready?: Promise<unknown>;
  private pending = new Map<
    string,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      progress?: (event: KernelEvent) => void;
      timer: ReturnType<typeof setTimeout>;
      method: string;
    }
  >();
  private initialize(): Promise<unknown> {
    if (this.ready) return this.ready;
    this.worker =
      this.kernelName === "xeus-python-019"
        ? new Worker(`${import.meta.env.BASE_URL}xeus/worker.js`)
        : this.kernelName === "pyodide-027"
          ? new Worker(
              new URL("./browser-kernel-py312.worker.ts", import.meta.url),
              { type: "module" },
            )
          : new Worker(new URL("./browser-kernel.worker.ts", import.meta.url), {
              type: "module",
            });
    this.buffer =
      this.kernelName !== "xeus-python-019" && globalThis.crossOriginIsolated
        ? new Uint8Array(new SharedArrayBuffer(1))
        : undefined;
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return; // Ignore late messages after timeout/restart.
      try {
        if (data.event) {
          pending.progress?.(data.event);
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.result);
      } catch (error) {
        this.close();
        pending.reject(
          error instanceof Error ? error : new Error("Malformed kernel event"),
        );
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.close();
    };
    this.ready = this.send("initialize", "", 0, 120_000);
    return this.ready;
  }
  private send(
    method: string,
    code: string,
    cursor: number,
    timeout: number,
    progress?: (event: KernelEvent) => void,
    workspace?: unknown,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Browser kernel timed out; it was stopped. Restart to continue (variables were lost).",
          ),
        );
        this.close();
      }, timeout);
      this.pending.set(id, { resolve, reject, progress, timer, method });
      this.worker!.postMessage({
        id,
        method,
        code,
        cursor,
        buffer: method === "initialize" ? this.buffer?.buffer : undefined,
        workspace,
      });
    });
  }
  async request(
    method: "execute" | "complete" | "inspect",
    code: string,
    cursor: number,
    timeout: number,
    progress?: (event: KernelEvent) => void,
  ) {
    const deadline = setTimeout(
      () =>
        this.close(
          "Browser kernel timed out and was stopped; variables were lost. Restart and retry.",
        ),
      timeout,
    );
    try {
      await this.initialize();
      if (this.workspace)
        await this.send(
          "workspace",
          "",
          0,
          timeout,
          undefined,
          await this.workspace(),
        );
      if (this.buffer) Atomics.store(this.buffer, 0, 0);
      return await this.send(method, code, cursor, timeout, progress);
    } finally {
      clearTimeout(deadline);
    }
  }
  interrupt(): void {
    const active = [...this.pending].find(
      ([, request]) => request.method === "execute",
    );
    if (!active) return;
    if (this.buffer) Atomics.store(this.buffer, 0, 2);
    // A JupyterLite coroutine may not settle on SIGINT; never strand the UI.
    setTimeout(
      () => {
        if (this.pending.has(active[0]))
          this.close(
            "Execution interrupted by stopping the browser worker; variables were lost. Run again to start a fresh kernel.",
          );
      },
      this.buffer ? 1500 : 0,
    );
  }
  async restart(): Promise<void> {
    this.close();
    await this.initialize();
  }
  close(
    reason = "Browser kernel stopped; restart and retry (variables were lost)",
  ): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
    this.buffer = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
