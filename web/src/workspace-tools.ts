import type {
  NotebookToolInvoker,
  ToolDefinition,
  ToolResult,
} from "./notebook-tools";

export interface OpenNotebook {
  tools: NotebookToolInvoker;
  path?(): string;
  activeContext?(): Record<string, unknown> | null;
  collaboration?(): Record<string, unknown>;
  changeDriver?(clientId: string): Promise<void>;
  canWrite?(): boolean;
  ready(): void;
  activate(): Promise<void>;
  deactivate(): void;
  dispose(): void;
}
const pathField = { type: "string" as const, minLength: 1, maxLength: 512 };
function path(value: unknown, root = false): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    (!value && !root) ||
    /[\\%?#:\x00-\x1f]/.test(value) ||
    (value && value.split("/").some((part) => !part || part.startsWith(".")))
  )
    throw new Error("Use a relative path inside the configured workspace");
  if (!root && !value.endsWith(".ipynb"))
    throw new Error("Notebook path must end in .ipynb");
  return value;
}
const result = (value: Record<string, unknown>, isError = false): ToolResult =>
  new TextEncoder().encode(JSON.stringify(value)).length > 200000
    ? result(
        {
          ok: false,
          error: {
            code: "bounds_exceeded",
            message:
              "Tool result exceeds limit; use a narrower folder or read_cell",
          },
        },
        true,
      )
    : {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
        isError,
      };
/** One page-local workspace; routing never falls back to whichever notebook is active. */
export class WorkspaceTools implements NotebookToolInvoker {
  private readonly notebooks = new Map<string, OpenNotebook>();
  private active: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly catalog: ToolDefinition[],
    private readonly create: (path: string) => Promise<OpenNotebook>,
    private readonly list: (directory: string) => Promise<unknown>,
  ) {}
  listTools(): ToolDefinition[] {
    const scoped: ToolDefinition[] = this.catalog.map((tool) => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          notebook_path: pathField,
          ...tool.inputSchema.properties,
        },
        required: ["notebook_path", ...tool.inputSchema.required],
      },
    }));
    for (const name of [
      "get_active_context",
      "list_open_notebooks",
      "list_notebooks",
      "open_notebook",
      "close_notebook",
      "get_collaboration",
      "change_notebook_driver",
      "change_workspace_driver",
    ]) {
      const properties: ToolDefinition["inputSchema"]["properties"] =
        name === "list_open_notebooks" || name === "get_active_context"
          ? {}
          : name === "list_notebooks"
            ? { directory: { ...pathField, minLength: 0 } }
            : ["change_notebook_driver", "change_workspace_driver"].includes(
                  name,
                )
              ? {
                  notebook_path: pathField,
                  client_id: { type: "string", minLength: 1, maxLength: 128 },
                }
              : { notebook_path: pathField };
      scoped.push({
        name,
        description: {
          get_active_context:
            "Read this frontend's active notebook, selected cell ID, zero-based cell index and edit/command mode. Local UI state only; no kernel request.",
          list_open_notebooks:
            "List notebooks open in this frontend workspace (not other browser tabs).",
          list_notebooks:
            "List notebooks and subfolders inside the configured workspace; directory may be empty for root.",
          open_notebook:
            "Open an existing notebook and select its egui view. Does not create files.",
          close_notebook:
            "Close this workspace's notebook view without deleting the file or stopping its kernel. Pending edits prevent closing.",
          get_collaboration:
            "Get this page's workspace-wide role, driver and connected client IDs through an open notebook. No credentials are returned.",
          change_notebook_driver:
            "Compatibility alias for change_workspace_driver: transfers control of ALL notebooks in this gateway workspace, not just the addressed notebook.",
          change_workspace_driver:
            "Transfer control of ALL notebooks in this gateway workspace to a connected client. Address any open notebook. Only the driver may hand off, with all edits saved and no running commands.",
        }[name]!,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties,
          required: Object.keys(properties),
        },
        annotations: {
          readOnlyHint:
            name.startsWith("list") ||
            name === "get_active_context" ||
            name === "get_collaboration",
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
    }
    return structuredClone(scoped);
  }
  async seed(notebook: string, context: OpenNotebook): Promise<void> {
    this.notebooks.set(notebook, context);
    this.active = notebook;
    await context.activate();
  }
  private async invoke(
    name: string,
    input: unknown,
    followGuard?: () => boolean,
  ): Promise<ToolResult> {
    // Human rename changes the transport's identity too; never route an old address to the new file.
    for (const [oldPath, context] of [...this.notebooks]) {
      const newPath = context.path?.() ?? oldPath;
      if (newPath !== oldPath) {
        path(newPath);
        if (this.notebooks.has(newPath))
          throw new Error("Notebook identity conflict");
        this.notebooks.delete(oldPath);
        this.notebooks.set(newPath, context);
        if (this.active === oldPath) this.active = newPath;
      }
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Arguments must be an object");
    const args = input as Record<string, unknown>;
    const definition = this.listTools().find((tool) => tool.name === name);
    if (!definition) throw new Error("Unknown workspace tool");
    if (
      Object.keys(args).some(
        (key) => !Object.hasOwn(definition.inputSchema.properties, key),
      ) ||
      definition.inputSchema.required.some((key) => !Object.hasOwn(args, key))
    )
      throw new Error("Missing or unknown arguments");
    if (name === "get_active_context")
      return result({
        ok: true,
        context:
          this.notebooks.get(this.active ?? "")?.activeContext?.() ?? null,
      });
    if (name === "list_open_notebooks")
      return result({
        ok: true,
        notebooks: [...this.notebooks.keys()].map((notebook_path) => ({
          notebook_path,
          active: notebook_path === this.active,
        })),
      });
    if (name === "list_notebooks")
      return result({
        ok: true,
        listing: await this.list(path(args.directory, true)),
      });
    const notebook = path(args.notebook_path);
    if (name === "open_notebook") {
      this.notebooks.get(this.active ?? "")?.ready();
      let context = this.notebooks.get(notebook);
      if (!context) {
        if (this.notebooks.size >= 16)
          throw new Error("Close a notebook before opening more (limit 16)");
        context = await this.create(notebook);
        this.notebooks.set(notebook, context);
      }
      if (followGuard && (!followGuard() || context.canWrite?.()))
        return result({ ok: false, cancelled: true }, true);
      if (this.active !== notebook) {
        const previous = this.notebooks.get(this.active ?? "");
        previous?.deactivate();
        try {
          await context.activate();
        } catch (error) {
          await previous?.activate();
          throw error;
        }
        this.active = notebook;
      }
      return result({ ok: true, notebook_path: notebook, active: true });
    }
    const context = this.notebooks.get(notebook);
    if (!context)
      return result(
        {
          ok: false,
          error: {
            code: "notebook_not_open",
            message: "Open this notebook first",
          },
        },
        true,
      );
    if (name === "close_notebook") {
      context.ready();
      context.dispose();
      this.notebooks.delete(notebook);
      if (this.active === notebook) this.active = null;
      return result({
        ok: true,
        notebook_path: notebook,
        closed: true,
        kernel_preserved: true,
      });
    }
    if (name === "get_collaboration")
      return result({
        ok: true,
        notebook_path: notebook,
        ...context.collaboration?.(),
      });
    if (
      context.canWrite &&
      !context.canWrite() &&
      !definition.annotations.readOnlyHint &&
      !["set_cell_visibility", "set_output_visibility"].includes(name)
    )
      return result(
        {
          ok: false,
          error: {
            code: "not_driver",
            message: "Read-only: only the notebook driver may change it",
          },
        },
        true,
      );
    if (["change_notebook_driver", "change_workspace_driver"].includes(name)) {
      if (
        typeof args.client_id !== "string" ||
        args.client_id.length > 128 ||
        !args.client_id
      )
        throw new Error("Invalid client ID");
      if (!context.changeDriver) throw new Error("Driver handoff unavailable");
      for (const notebook of this.notebooks.values()) notebook.ready();
      await context.changeDriver(args.client_id);
      return result({
        ok: true,
        notebook_path: notebook,
        driver_id: args.client_id,
      });
    }
    const { notebook_path: _, ...cellArgs } = args;
    const response = await context.tools.callTool(name, cellArgs);
    const addressed = result(
      { ...response.structuredContent, notebook_path: notebook },
      response.isError,
    );
    return {
      ...addressed,
      content: [
        ...response.content.filter((item) => item.type === "image"),
        ...addressed.content,
      ],
    };
  }
  callTool(name: string, input: unknown): Promise<ToolResult> {
    const run = () =>
      this.invoke(name, input).catch(() =>
        result(
          {
            ok: false,
            error: {
              code: "invalid_input",
              message:
                "Invalid workspace request or unsaved/busy notebook. Check paths and save edits before switching or closing.",
            },
          },
          true,
        ),
      );
    if (
      name === "interrupt_kernel" ||
      name === "get_active_context" ||
      name === "get_collaboration"
    )
      return run();
    const task = this.tail.then(run);
    this.tail = task;
    return task;
  }
  async openForFollow(
    notebook: string,
    current: () => boolean,
  ): Promise<boolean> {
    const task = this.tail.then(async () => {
      if (!current()) return false;
      return !(
        await this.invoke("open_notebook", { notebook_path: notebook }, current)
      ).isError;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  dispose(): void {
    for (const context of this.notebooks.values()) context.dispose();
    this.notebooks.clear();
  }
}
