import { PyodideRemoteKernel } from "@jupyterlite/pyodide-kernel/lib/worker";
import type { IPyodideWorkerKernel } from "@jupyterlite/pyodide-kernel/lib/tokens";
import type { PyodideAPI } from "pyodide";
import { browserPath } from "./browser-store";

/** JupyterLite owns IPython semantics; this host owns only worker I/O/policy. */
class Kernel extends PyodideRemoteKernel {
  private mounted = new Set<string>();
  mountWorkspace(workspace: {
    files: { path: string; directory: boolean; bytes: Uint8Array }[];
    directory: string;
  }) {
    const fs = this._pyodide.FS;
    browserPath(workspace.directory, true);
    if (
      workspace.files.length > 1000 ||
      workspace.files.reduce((n, f) => n + f.bytes.length, 0) > 20_000_000
    )
      throw new Error("Workspace exceeds limit");
    const checkLinks = (target: string) => {
      let current = "";
      for (const part of target.split("/").filter(Boolean)) {
        current += "/" + part;
        if (
          fs.analyzePath(current, true).exists &&
          fs.isLink(fs.lstat(current).mode)
        )
          throw new Error("Workspace symlinks are unsupported");
      }
    };
    checkLinks("/workspace");
    fs.mkdirTree("/workspace");
    for (const file of workspace.files) {
      browserPath(file.path, true);
      if (!file.path || file.bytes.length > 1_000_000)
        throw new Error("Invalid workspace file");
      const target = `/workspace/${file.path}`;
      // Do not follow a link created by notebook code, even inside the worker FS.
      const parts = target.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += `/${part}`;
        if (
          fs.analyzePath(current, true).exists &&
          fs.isLink(fs.lstat(current).mode)
        )
          throw new Error("Workspace symlinks are unsupported");
      }
      if (this.mounted.has(file.path)) continue;
      fs.mkdirTree(
        file.directory ? target : target.slice(0, target.lastIndexOf("/")),
      );
      if (!file.directory) fs.writeFile(target, file.bytes);
      this.mounted.add(file.path);
    }
    const cwd = `/workspace${workspace.directory ? `/${workspace.directory}` : ""}`;
    checkLinks(cwd);
    fs.mkdirTree(cwd);
    fs.chdir(cwd);
  }
  interrupt?: Uint8Array;
  executionCount(): number {
    return Number(this._interpreter.execution_count) - 1;
  }
  protected override async initRuntime(options: IPyodideWorkerKernel.IOptions) {
    const module = await import(/* @vite-ignore */ options.pyodideUrl);
    this._pyodide = (await module.loadPyodide({
      indexURL: options.indexUrl,
      stdout: () => {},
      stderr: () => {},
    })) as PyodideAPI;
    await this._pyodide.loadPackage(["ipython", "jedi", "matplotlib"]);
  }
  protected override async initGlobals(options: IPyodideWorkerKernel.IOptions) {
    await super.initGlobals(options);
    if (this.interrupt) this._pyodide.setInterruptBuffer(this.interrupt);
  }
  protected override sendInputRequest(): never {
    throw new Error("Interactive stdin is unsupported in browser mode");
  }
  override async sendComm(): Promise<void> {
    // Widget comms are deliberately not exposed by this application.
  }
}
const kernel = new Kernel();
let activeId = "";
kernel.registerLogMessageCallback(() => {});
kernel.registerWorkerMessageCallback((event: unknown) => {
  const encoded = JSON.stringify(event);
  if (new TextEncoder().encode(encoded).length > 1_000_000)
    throw new Error("Kernel output exceeds message limit");
  self.postMessage({ id: activeId, event });
});
let tail = Promise.resolve();
self.onmessage = (message: MessageEvent) => {
  const { id, method, code, cursor, buffer, workspace } = message.data;
  tail = tail.then(async () => {
    activeId = id;
    try {
      let result: unknown;
      if (method === "initialize") {
        kernel.interrupt = buffer ? new Uint8Array(buffer) : undefined;
        const base = new URL("/browser-kernel/", self.location.href).href;
        await kernel.initialize({
          baseUrl: base,
          indexUrl: base,
          pyodideUrl: `${base}pyodide.mjs`,
          pipliteWheelUrl: `${base}piplite-0.8.5-py3-none-any.whl`,
          pipliteUrls: [`${base}all.json`],
          disablePyPIFallback: true,
          location: "",
          mountDrive: false,
          loadPyodideOptions: {
            lockFileURL: `${base}pyodide-lock.json`,
            packages: [],
          },
        });
        result = {};
      } else if (method === "workspace") {
        kernel.mountWorkspace(workspace);
        result = {};
      } else {
        const parent = { header: { msg_id: id } };
        if (method === "execute") {
          result = await kernel.execute(
            {
              code,
              silent: false,
              store_history: true,
              user_expressions: {},
              allow_stdin: false,
              stop_on_error: true,
            },
            parent,
          );
          result = {
            ...(result as Record<string, unknown>),
            execution_count: kernel.executionCount(),
          };
        } else if (method === "complete")
          result = await kernel.complete({ code, cursor_pos: cursor }, parent);
        else if (method === "inspect")
          result = await kernel.inspect(
            { code, cursor_pos: cursor, detail_level: 0 },
            parent,
          );
        else throw new Error("Unsupported kernel operation");
      }
      self.postMessage({ id, result });
    } catch {
      // Never leak code, outputs, or runtime internals into routine logs/errors.
      self.postMessage({
        id,
        error: "Browser kernel operation failed; restart the kernel and retry",
      });
    }
  });
};
