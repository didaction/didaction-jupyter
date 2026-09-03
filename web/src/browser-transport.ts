import type {
  NotebookCommand,
  NotebookSnapshot,
  CommandResult,
  NotebookTransport,
  NotebookProgress,
  WasmApplication,
} from "./types";
import type { BrowserKernel } from "./browser-kernel";
import {
  prepareRuntimeCommand,
  microscopeDocument,
} from "../pkg/notebook_wasm";
import { OutputReducer, type Output } from "./browser-outputs";
import { browserPath, type NotebookStore } from "./browser-store";

export interface BrowserSnapshot extends NotebookSnapshot {
  schema_version: 1;
  notebook: { path: string; workspace: string };
  kernel: {
    name: string;
    display_name: string;
    session_id: null;
    state: string;
  };
  selected_cell_id: string | null;
  cells: {
    id: string;
    cell_type: string;
    source: string;
    metadata: unknown;
    execution_count: number | null;
    outputs: Output[];
  }[];
}
export function initialBrowserSnapshot(
  path: string,
  kernelName: "pyodide" | "xeus-python" = "pyodide",
): BrowserSnapshot {
  return {
    protocol_version: 1,
    schema_version: 1,
    notebook: { path: browserPath(path), workspace: "browser-local" },
    kernel: {
      name: kernelName,
      display_name:
        kernelName === "pyodide"
          ? "Python (browser · Pyodide)"
          : "Python (browser · xeus-python)",
      session_id: null,
      state: "idle",
    },
    revision: 0,
    selected_cell_id: null,
    cells:
      path === "browser-demo.ipynb"
        ? [
            {
              id: "browser-intro",
              cell_type: "markdown",
              source:
                "# Python in your browser\n\nRun cells with **Shift+Enter**. No gateway or Jupyter Server is used. Notebooks are saved in this browser; reload/restart loses Python variables. Kernel file access is temporary and separate from notebook storage.",
              metadata: {},
              execution_count: null,
              outputs: [],
            },
            {
              id: "browser-example",
              cell_type: "code",
              source: "value = 40 + 2\nvalue",
              metadata: {},
              execution_count: null,
              outputs: [],
            },
            {
              id: "browser-plot",
              cell_type: "code",
              source:
                "import matplotlib.pyplot as plt\nplt.bar(['a', 'b'], [2, 4])\nplt.show()",
              metadata: {},
              execution_count: null,
              outputs: [],
            },
            {
              id: "browser-stream",
              cell_type: "code",
              source:
                "import asyncio\nfrom IPython.display import display, clear_output\nfor step in range(5):\n    clear_output(wait=True)\n    display(f'Progress: {step + 1}/5')\n    await asyncio.sleep(0.5)",
              metadata: {},
              execution_count: null,
              outputs: [],
            },
          ]
        : [],
  };
}

/** A second real NotebookTransport. Cell transitions still run through Rust. */
export class BrowserNotebookTransport implements NotebookTransport {
  private snapshot: BrowserSnapshot;
  private active = false;
  private cache = new Map<
    string,
    { fingerprint: string; result: CommandResult }
  >();
  constructor(
    path: string,
    private readonly store: NotebookStore,
    private readonly kernel: BrowserKernel,
    private readonly model: (snapshot: string) => WasmApplication,
    private readonly kernelName: "pyodide" | "xeus-python" = "pyodide",
  ) {
    this.snapshot = initialBrowserSnapshot(path, kernelName);
  }
  private validate(snapshot: BrowserSnapshot) {
    const check = this.model(JSON.stringify(snapshot));
    check.dispose();
  }
  private result(
    command: NotebookCommand,
    base: number,
    snapshot = this.snapshot,
  ): CommandResult {
    return {
      protocol_version: 1,
      command_id: command.command_id,
      idempotency_key: command.idempotency_key,
      base_revision: base,
      committed_revision: snapshot.revision,
      snapshot: structuredClone(snapshot),
    };
  }
  private async run(
    command: NotebookCommand,
    progress?: NotebookProgress,
  ): Promise<CommandResult> {
    const base = this.snapshot.revision;
    const fingerprint = JSON.stringify(command);
    const cached = this.cache.get(command.idempotency_key);
    if (cached?.fingerprint === fingerprint)
      return structuredClone(cached.result);
    if (cached || this.active)
      return this.failure(
        command,
        cached ? "duplicate_command" : "execution_rejected",
        "Conflicting or concurrent command; wait for execution to finish",
      );
    this.active = true;
    let model: WasmApplication | undefined;
    try {
      model = this.model(JSON.stringify(this.snapshot));
      model.prepareCommand(JSON.stringify(command));
      let next = JSON.parse(
        prepareRuntimeCommand(
          JSON.stringify(this.snapshot),
          JSON.stringify(command),
        ),
      ) as BrowserSnapshot;
      let result: CommandResult;
      let microscope: Record<string, unknown> | undefined;
      let sidecar:
        | { path: string; content: string | null; previous?: string }
        | undefined;
      if (command.type === "setup") {
        if (
          command.path !== this.snapshot.notebook.path ||
          (command.kernel && command.kernel !== this.kernelName)
        )
          throw new Error(
            "Browser mode uses its own workspace and the configured browser kernel",
          );
        const saved = await this.store.read(String(command.path));
        if (!saved && !command.create)
          throw new Error("Notebook not found in browser storage");
        next = saved ? (structuredClone(saved) as BrowserSnapshot) : next;
        next.kernel = initialBrowserSnapshot(
          next.notebook.path,
          this.kernelName,
        ).kernel;
      } else if (
        [
          "create_microscope",
          "delete_microscope",
          "read_microscope",
          "set_microscope_walkthrough",
        ].includes(command.type)
      ) {
        const selected =
          command.type === "create_microscope" ? next : this.snapshot;
        let identity = JSON.parse(
          microscopeDocument(
            JSON.stringify(selected),
            String(command.cell_id),
            String(command.microscope_id),
            undefined,
          ),
        );
        if (!this.store.artifacts)
          throw new Error("Microscope storage unavailable");
        const files = await this.store.artifacts();
        const stored = files.find((f) => f.path === identity.path);
        if (stored)
          identity = JSON.parse(
            microscopeDocument(
              JSON.stringify(selected),
              String(command.cell_id),
              String(command.microscope_id),
              new TextDecoder().decode(stored.bytes),
            ),
          );
        if (command.type === "read_microscope") {
          if (!stored) throw new Error("Microscope content file is missing");
          microscope = identity.document;
        } else if (command.type === "set_microscope_walkthrough") {
          if (!stored) throw new Error("Microscope content file is missing");
          const updated = JSON.parse(
            microscopeDocument(
              JSON.stringify(next),
              String(command.cell_id),
              String(command.microscope_id),
              undefined,
            ),
          );
          updated.document.walkthrough = command.walkthrough;
          const validated = JSON.parse(
            microscopeDocument(
              JSON.stringify(next),
              String(command.cell_id),
              String(command.microscope_id),
              JSON.stringify(updated.document),
            ),
          );
          microscope = validated.document;
          sidecar = {
            path: identity.path,
            content: JSON.stringify(microscope),
            previous: new TextDecoder().decode(stored.bytes),
          };
        } else {
          if (command.type === "create_microscope" && stored)
            throw new Error("Microscope sidecar already exists");
          if (command.type === "create_microscope") {
            identity.document.walkthrough = command.walkthrough;
            microscope = identity.document;
          }
          sidecar = {
            path: identity.path,
            previous: stored
              ? new TextDecoder().decode(stored.bytes)
              : undefined,
            content:
              command.type === "create_microscope"
                ? JSON.stringify(identity.document)
                : null,
          };
        }
      } else if (command.type === "execute_cell") {
        const cell = next.cells.find((cell) => cell.id === command.cell_id);
        if (!cell || cell.cell_type !== "code")
          throw new Error("Select a code cell to execute");
        const reducer = new OutputReducer();
        cell.outputs = [];
        cell.execution_count = null;
        next.kernel.state = "busy";
        progress?.(this.result(command, base, next));
        const reply = await this.kernel.request(
          "execute",
          cell.source,
          0,
          command.timeout_ms,
          (event) => {
            reducer.apply(event);
            cell.outputs = structuredClone(reducer.outputs);
            this.validate(next);
            progress?.(this.result(command, base, next));
          },
        );
        cell.execution_count =
          typeof reply.execution_count === "number"
            ? reply.execution_count
            : null;
        next.kernel.state = "idle";
      } else if (command.type === "complete" || command.type === "inspect") {
        const reply = await this.kernel.request(
          command.type,
          String(command.code),
          Number(command.cursor_pos),
          command.timeout_ms,
        );
        result = {
          protocol_version: 1,
          command_id: command.command_id,
          idempotency_key: command.idempotency_key,
          base_revision: base,
          committed_revision: base,
        };
        if (command.type === "complete") {
          if (
            !Array.isArray(reply.matches) ||
            !reply.matches.every(
              (match) => typeof match === "string" && match.length <= 1024,
            ) ||
            !Number.isInteger(reply.cursor_start) ||
            !Number.isInteger(reply.cursor_end) ||
            Number(reply.cursor_start) < 0 ||
            Number(reply.cursor_end) >
              Array.from(String(command.code)).length ||
            Number(reply.cursor_end) < Number(reply.cursor_start)
          )
            throw new Error("Malformed completion response");
          result.completion = {
            matches: (reply.matches as string[]).slice(0, 256),
            cursor_start: Number(reply.cursor_start),
            cursor_end: Number(reply.cursor_end),
          };
        } else
          result.inspection = {
            found: reply.found === true,
            text: String(
              (reply.data as Record<string, unknown> | undefined)?.[
                "text/plain"
              ] ?? "",
            ).slice(0, 65536),
          };
        model.applyCommandResult(JSON.stringify(result));
        return result;
      } else if (command.type === "restart_kernel") {
        await this.kernel.restart();
        next.kernel.state = "idle";
      } else if (command.type === "rename_notebook") {
        next.notebook.path = browserPath(String(command.path));
      } else if (
        ![
          "query",
          "reconnect",
          "modify_cells",
          "create_checkpoint",
          "download_notebook",
        ].includes(command.type)
      ) {
        return this.failure(
          command,
          "unsupported_operation",
          "Operation is not supported by the browser runtime",
        );
      }
      if (
        next.selected_cell_id &&
        !next.cells.some((cell) => cell.id === next.selected_cell_id)
      )
        next.selected_cell_id = null;
      if (
        ![
          "query",
          "reconnect",
          "setup",
          "download_notebook",
          "read_microscope",
        ].includes(command.type)
      )
        next.revision = base + 1;
      this.validate(next);
      result = this.result(command, base, next);
      if (microscope) result.microscope = microscope;
      // Commit durable notebook storage before acknowledging a command.
      if (sidecar) {
        if (!this.store.commitMicroscope)
          throw new Error("Microscope storage unavailable");
        await this.store.commitMicroscope(
          next,
          sidecar.path,
          sidecar.content,
          sidecar.previous,
        );
      } else if (command.type === "rename_notebook")
        await this.store.rename(
          this.snapshot.notebook.path,
          next.notebook.path,
          next,
        );
      else await this.store.write(next.notebook.path, next);
      this.snapshot = next;
      this.cache.set(command.idempotency_key, {
        fingerprint,
        result: structuredClone(result),
      });
      if (this.cache.size > 16)
        this.cache.delete(this.cache.keys().next().value!);
      return result;
    } catch (error) {
      const failed = this.failure(
        command,
        "transport_error",
        error instanceof Error ? error.message : "Browser runtime failed",
      );
      // Execution may already have changed the Python heap. Never repeat it
      // automatically under the same idempotency key after an uncertain result.
      if (command.type === "execute_cell")
        this.cache.set(command.idempotency_key, {
          fingerprint,
          result: failed,
        });
      if (this.cache.size > 16)
        this.cache.delete(this.cache.keys().next().value!);
      return failed;
    } finally {
      model?.dispose();
      this.active = false;
    }
  }
  private failure(
    command: NotebookCommand,
    code: string,
    message: string,
  ): CommandResult {
    return {
      protocol_version: 1,
      command_id: command.command_id,
      idempotency_key: command.idempotency_key,
      base_revision: this.snapshot.revision,
      committed_revision: null,
      error: { code, message: message.slice(0, 1024), retryable: true },
    };
  }
  setup = (command: NotebookCommand) => this.run(command);
  query = this.setup;
  modifyCells = this.setup;
  execute = (command: NotebookCommand, progress?: NotebookProgress) =>
    this.run(command, progress);
  complete = this.setup;
  inspect = this.setup;
  restart = this.setup;
  reconnect = this.setup;
  rename = this.setup;
  // Checkpoint restore has no public command yet; don't misrepresent ordinary saves.
  checkpoint = async (command: NotebookCommand) =>
    this.failure(
      command,
      "unsupported_operation",
      "Browser checkpoints are not implemented; download a backup",
    );
  interrupt = async (command: NotebookCommand) => {
    const model = this.model(JSON.stringify(this.snapshot));
    try {
      model.prepareCommand(JSON.stringify(command));
      this.kernel.interrupt();
      return this.result(command, this.snapshot.revision);
    } catch (error) {
      return this.failure(
        command,
        "unsupported_operation",
        error instanceof Error ? error.message : "Interrupt unavailable",
      );
    } finally {
      model.dispose();
    }
  };
  download = async (command: NotebookCommand) => {
    const result = await this.run(command);
    if (result.error) return result;
    const cells = this.snapshot.cells.map((cell) =>
      cell.cell_type !== "code"
        ? {
            id: cell.id,
            cell_type: cell.cell_type,
            source: cell.source,
            metadata: cell.metadata,
          }
        : {
            ...cell,
            outputs: cell.outputs.map((output) => {
              if (output.kind === "stream")
                return {
                  output_type: "stream",
                  name: output.name,
                  text: output.text,
                };
              if (output.kind === "error")
                return {
                  output_type: "error",
                  ename: output.name,
                  evalue: output.message,
                  traceback: output.traceback,
                };
              return {
                output_type: "display_data",
                metadata: {},
                data:
                  output.kind === "text"
                    ? { "text/plain": output.text }
                    : {
                        [output.mime]:
                          output.mime === "image/svg+xml"
                            ? new TextDecoder().decode(
                                Uint8Array.from(atob(output.data), (char) =>
                                  char.charCodeAt(0),
                                ),
                              )
                            : output.data,
                      },
              };
            }),
          },
    );
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify({
            nbformat: 4,
            nbformat_minor: 5,
            metadata: {},
            cells,
          }),
        ],
        { type: "application/x-ipynb+json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = this.snapshot.notebook.path.split("/").at(-1)!;
    link.click();
    URL.revokeObjectURL(url);
    return result;
  };
  close = async () => this.kernel.close();
}
