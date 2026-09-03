/** Temporary notebook extension of the existing editor, not a second editor.
 * Read: the walkthrough remains the return destination. Operate: one code cell,
 * existing completion/output controls, top-left exit, explicit disposable state.
 * The existing light notebook palette and canvas layout remain authoritative.
 */
import {
  mountNotebook,
  NotebookApplication,
  playgroundSnapshot,
} from "../pkg/notebook_wasm";
import {
  CommandGateway,
  createQueuedNotebookDispatcher,
} from "./command-gateway";
import { GatewayNotebookTransport } from "./gateway-client";
import type {
  NotebookCommand,
  NotebookSnapshot,
  NotebookTransport,
  CommandResult,
  NotebookProgress,
} from "./types";

type View = {
  id: string;
  notebook_path: string;
  cell_id: string;
  microscope_id: string;
  step_index: number;
  step_id: string;
  step_title: string;
  snapshot: NotebookSnapshot;
  closing?: boolean;
};
type Hooks = {
  path(): string;
  headers(): Record<string, string>;
  canWrite(): boolean;
  document(cellId: string, microscopeId: string): Promise<unknown>;
  enter(document: unknown, index: number): void;
  valid(cellId: string, microscopeId: string, revision: number): boolean;
  stopFollowing(): void;
};
const command = (
  type: string,
  values: Record<string, unknown> = {},
): NotebookCommand => ({
  protocol_version: 1,
  command_id: crypto.randomUUID(),
  idempotency_key: crypto.randomUUID(),
  timeout_ms: 30000,
  type,
  ...values,
});
function allowed(c: NotebookCommand): boolean {
  if (
    [
      "query",
      "reconnect",
      "execute_cell",
      "complete",
      "inspect",
      "interrupt_kernel",
    ].includes(c.type)
  )
    return c.cell_id === undefined || c.cell_id === "playground";
  return (
    c.type === "modify_cells" &&
    Array.isArray(c.changes) &&
    c.changes.every(
      (change) =>
        ["update", "clear_outputs"].includes(change.operation) &&
        change.cell_id === "playground" &&
        change.cell_type === undefined,
    )
  );
}
/** Owns one view and its lifetime. Server authority never trusts this UI guard. */
export class PlaygroundController {
  private current?: View;
  private transport?: NotebookTransport;
  private wasm?: NotebookApplication;
  private mounted?: Awaited<ReturnType<typeof mountNotebook>>;
  private dispatcher?: ReturnType<typeof createQueuedNotebookDispatcher>;
  private panel?: HTMLElement;
  private message?: HTMLElement;
  private generation = 0;
  private busy = false;
  private polling = false;
  private disposed = false;
  private following = false;
  private executingSource?: string;
  private contentRevision?: number;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly hooks: Hooks) {
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {
        this.mounted?.setReadOnly(true);
        if (this.message)
          this.message.textContent =
            "Connection lost; retry exit to clean up the playground.";
      });
    }, 500);
  }
  setFollowing(value: boolean) {
    this.following = value;
    if (!value && this.current && !this.hooks.canWrite()) void this.unmount();
  }
  snapshot() {
    if (this.mounted) return JSON.parse(this.mounted.notebookSnapshot());
    return this.wasm ? JSON.parse(this.wasm.publicSnapshot()).snapshot : null;
  }
  activeContext() {
    if (!this.current) return null;
    const snapshot = this.snapshot() as NotebookSnapshot & {
      kernel?: { state?: string };
      cells: Array<{
        source?: string;
        outputs?: unknown[];
        execution_count?: number | null;
      }>;
    };
    const cell = snapshot.cells[0] ?? {};
    const mounted = this.mounted
      ? (JSON.parse(this.mounted.activeContext()) as {
          selection?: {
            draft?: { source?: string; dirty?: boolean };
            execution?: { status?: string; source?: string } | null;
          } | null;
        })
      : {};
    const selection = mounted.selection;
    const uiExecution = selection?.execution;
    const running =
      this.executingSource !== undefined ||
      uiExecution?.status === "running" ||
      uiExecution?.status === "queued" ||
      snapshot.kernel?.state === "busy";
    return {
      owner: {
        notebook_path: this.current.notebook_path,
        cell_id: this.current.cell_id,
        microscope_id: this.current.microscope_id,
      },
      step: {
        index: this.current.step_index,
        id: this.current.step_id,
        title: this.current.step_title,
      },
      role: this.hooks.canWrite() ? "owner" : "observer",
      draft: {
        source: selection?.draft?.source ?? cell.source ?? "",
        dirty: selection?.draft?.dirty ?? false,
      },
      execution: {
        status: this.current.closing ? "closing" : running ? "running" : "idle",
        source:
          this.executingSource ??
          uiExecution?.source ??
          (running ? (cell.source ?? "") : null),
        execution_count: cell.execution_count ?? null,
      },
      outputs: cell.outputs ?? [],
    };
  }
  private async request(route: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`/api/v1/playground${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-notebook-path": encodeURIComponent(this.hooks.path()),
        ...this.hooks.headers(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new Error(
        `Playground request failed (${response.status}); retry or close the playground`,
      );
    const text = await response.text();
    if (text.length > 4_000_000)
      throw new Error("Playground response exceeded bounds");
    return JSON.parse(text);
  }
  async open(cellId: string, microscopeId: string, stepIndex: number) {
    if (!this.hooks.canWrite())
      throw new Error("Only the driver can open playgrounds");
    if (this.busy || this.current)
      throw new Error("Close the current playground first");
    this.busy = true;
    const generation = this.generation;
    try {
      const doc = await this.hooks.document(cellId, microscopeId);
      const step = (
        doc as {
          walkthrough?: { steps?: Array<{ id?: string; title?: string }> };
        }
      ).walkthrough?.steps?.[stepIndex];
      if (!step?.id || !step.title)
        throw new Error("Playground step is unavailable");
      this.contentRevision =
        (doc as { microscope: { revision?: number } }).microscope.revision ?? 0;
      let view: View;
      let transport: NotebookTransport;
      if (import.meta.env.VITE_NOTEBOOK_RUNTIME === "browser") {
        const [{ BrowserNotebookTransport }, { WorkerKernel }] =
          await Promise.all([
            import("./browser-transport"),
            import("./browser-kernel"),
          ]);
        const kernelName =
          new URL(location.href).searchParams.get("kernel") === "xeus-python"
            ? "xeus-python"
            : "pyodide";
        const snapshot = JSON.parse(
          playgroundSnapshot(JSON.stringify(doc), stepIndex, kernelName),
        ) as NotebookSnapshot;
        let saved = structuredClone(snapshot);
        transport = new BrowserNotebookTransport(
          "playground.ipynb",
          {
            read: async () => structuredClone(saved),
            write: async (_path, snapshot) => {
              saved = structuredClone(snapshot);
            },
            rename: async () => {
              throw new Error("Temporary notebooks cannot be renamed");
            },
            list: async () => ({ directory: "", entries: [] }),
          },
          new WorkerKernel(undefined, kernelName),
          (input) => new NotebookApplication(input),
          kernelName,
        );
        const setup = await transport.setup(
          command("setup", {
            path: "playground.ipynb",
            kernel: kernelName,
            create: false,
          }),
        );
        if (setup.error) throw new Error(setup.error.message);
        view = {
          id: crypto.randomUUID(),
          notebook_path: this.hooks.path(),
          cell_id: cellId,
          microscope_id: microscopeId,
          step_index: stepIndex,
          step_id: step.id,
          step_title: step.title,
          snapshot: setup.snapshot!,
        };
      } else {
        view = (await this.request("", {
          cell_id: cellId,
          microscope_id: microscopeId,
          step_index: stepIndex,
        })) as View;
        view.step_id = step.id;
        view.step_title = step.title;
        transport = this.serverTransport(view.id);
      }
      if (this.disposed || this.generation !== generation) {
        await transport.close();
        if (import.meta.env.VITE_NOTEBOOK_RUNTIME !== "browser")
          await this.request("/close", { id: view.id });
        return;
      }
      this.hooks.enter(doc, stepIndex);
      await this.mount(view, transport, false);
    } finally {
      this.busy = false;
    }
  }
  private serverTransport(id: string) {
    return new GatewayNotebookTransport(
      `/api/v1/playground/${encodeURIComponent(id)}/commands`,
      this.hooks.path(),
      () => this.hooks.headers(),
    );
  }
  private async mount(
    view: View,
    transport: NotebookTransport,
    observer: boolean,
  ) {
    const generation = this.generation;
    this.current = view;
    this.transport = transport;
    this.wasm = new NotebookApplication(JSON.stringify(view.snapshot));
    const guarded = { ...transport } as NotebookTransport;
    for (const method of [
      "setup",
      "query",
      "modifyCells",
      "execute",
      "interrupt",
      "restart",
      "checkpoint",
      "rename",
      "download",
      "reconnect",
      "complete",
      "inspect",
    ] as const) {
      guarded[method] = async (
        c: NotebookCommand,
        progress?: NotebookProgress,
      ) => {
        if (!this.hooks.canWrite() || observer)
          throw new Error("Only the driver can change or execute a playground");
        if (!allowed(c))
          throw new Error(
            "Playgrounds contain one code cell and cannot be saved or extended",
          );
        return transport[method](c, progress);
      };
    }
    const gateway = new CommandGateway(this.wasm, guarded);
    this.dispatcher = createQueuedNotebookDispatcher(
      gateway,
      () => this.snapshot().revision,
    );
    const panel = document.createElement("section");
    panel.className = "playground-shell";
    panel.setAttribute("aria-label", "Temporary playground");
    const bar = document.createElement("div");
    bar.className = "playground-bar";
    const back = document.createElement("button");
    back.textContent = "Close playground";
    back.setAttribute(
      "aria-label",
      "Close playground and stop temporary session",
    );
    back.onclick = () => {
      void this.close().catch((error) => {
        message.textContent = String(error);
      });
    };
    const message = document.createElement("span");
    message.textContent = observer
      ? "Following driver · read-only"
      : "Fresh kernel · discarded on exit";
    bar.append(back, message);
    const canvas = document.createElement("canvas");
    canvas.id = "playground-canvas";
    canvas.setAttribute("aria-label", "Playground notebook editor");
    const viewport = document.createElement("div");
    viewport.className = "playground-viewport";
    viewport.append(canvas);
    panel.append(bar, viewport);
    document.querySelector("#notebook-shell")!.append(panel);
    this.panel = panel;
    this.message = message;
    const mounted = await mountNotebook(
      canvas.id,
      JSON.stringify(view.snapshot),
      async (serialized: string, progress?: (serialized: string) => void) => {
        const input = JSON.parse(serialized) as NotebookCommand;
        if (input.type !== "interrupt_kernel")
          return this.dispatcher!(serialized, progress);
        // Stop must bypass the execution queue, without advancing its validator.
        const validation = new NotebookApplication(
          JSON.stringify(this.snapshot()),
        );
        try {
          input.expected_revision = null;
          return await new CommandGateway(validation, guarded).execute(
            JSON.stringify(input),
          );
        } finally {
          validation.dispose();
        }
      },
    );
    if (generation !== this.generation || this.disposed) {
      mounted.dispose();
      return;
    }
    this.mounted = mounted;
    this.mounted.setReadOnly(observer);
    this.mounted.setHostStatus(observer, "Temporary playground");
  }
  async execute(source?: string) {
    if (!this.mounted || !this.dispatcher || !this.hooks.canWrite())
      throw new Error("Open a driver playground first");
    this.mounted.assertExternalReady();
    const generation = this.generation;
    const code = source ?? this.snapshot().cells[0].source;
    if (/^\s*(?:!|%pip\b|%conda\b|%%(?:bash|sh)\b)/m.test(code))
      throw new Error(
        "Shell and package-install magics are not exposed by notebook tools",
      );
    const send = async (c: NotebookCommand) => {
      const raw = await this.dispatcher!(JSON.stringify(c), (progress) => {
        if (generation === this.generation)
          this.mounted?.applyExternalResult(progress, true);
      });
      if (generation !== this.generation)
        throw new Error("Playground was closed");
      this.mounted?.applyExternalResult(raw, false);
      const result = JSON.parse(raw) as CommandResult;
      if (result.error) throw new Error(result.error.message);
      return result;
    };
    if (source !== undefined)
      await send(
        command("modify_cells", {
          changes: [
            {
              operation: "update",
              cell_id: "playground",
              source,
              metadata: null,
            },
          ],
        }),
      );
    this.executingSource = code;
    try {
      return await send(
        command("execute_cell", { cell_id: "playground", timeout_ms: 120000 }),
      );
    } finally {
      this.executingSource = undefined;
    }
  }
  async close() {
    if (
      import.meta.env.VITE_NOTEBOOK_RUNTIME !== "browser" &&
      this.current &&
      this.hooks.canWrite()
    ) {
      if (this.message) this.message.textContent = "Stopping temporary kernel…";
      await this.request("/close", { id: this.current.id });
    }
    if (this.current && !this.hooks.canWrite() && this.following)
      this.hooks.stopFollowing();
    await this.unmount();
  }
  private async unmount() {
    this.generation++;
    const transport = this.transport;
    this.mounted?.dispose();
    this.mounted = undefined;
    this.transport = undefined;
    this.wasm?.dispose();
    this.wasm = undefined;
    this.dispatcher = undefined;
    this.panel?.remove();
    this.panel = undefined;
    this.current = undefined;
    this.executingSource = undefined;
    await transport?.close();
  }
  private async refresh() {
    if (this.mounted?.takeDiagnosticsToggle())
      document.querySelector<HTMLButtonElement>("#diagnostics-toggle")?.click();
    if (
      this.current &&
      !this.busy &&
      this.hooks.canWrite() &&
      !this.hooks.valid(
        this.current.cell_id,
        this.current.microscope_id,
        this.contentRevision ?? 0,
      )
    ) {
      await this.close();
      return;
    }
    if (
      this.disposed ||
      this.busy ||
      this.polling ||
      import.meta.env.VITE_NOTEBOOK_RUNTIME === "browser"
    )
      return;
    if (!this.current && !this.following) return;
    this.polling = true;
    const generation = this.generation;
    try {
      const view = (await this.request("")) as View | null;
      if (generation !== this.generation || this.disposed) return;
      if (!view || view.closing) {
        await this.unmount();
        return;
      }
      if (!this.hooks.canWrite() && this.following) {
        if (this.current?.id !== view.id) {
          await this.unmount();
          await this.mount(view, this.serverTransport(view.id), true);
        } else {
          this.wasm!.replaceSnapshot(JSON.stringify(view.snapshot));
          this.mounted?.applyExternalResult(
            JSON.stringify({
              protocol_version: 1,
              command_id: crypto.randomUUID(),
              idempotency_key: crypto.randomUUID(),
              base_revision: null,
              committed_revision: view.snapshot.revision,
              snapshot: view.snapshot,
              error: null,
            }),
            false,
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    void this.close().catch(() => this.unmount());
  }
}
