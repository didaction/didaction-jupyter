import type { CommandResult, NotebookCommand, NotebookSnapshot } from "./types";

export type ToolResult = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" }
  )[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};
type Field = {
  description?: string;
  type: "string" | "integer" | "boolean" | "object" | "array";
  properties?: Record<string, Field>;
  required?: string[];
  additionalProperties?: false;
  items?: Field;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
};
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    properties: Record<string, Field>;
    required: string[];
  };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};
export interface NotebookToolInvoker {
  listTools(): ToolDefinition[];
  callTool(name: string, input: unknown): Promise<ToolResult>;
}
export type Execute = (serialized: string) => Promise<string>;
export type Transaction = <T>(
  task: (execute: Execute) => Promise<T>,
) => Promise<T>;
type Cell = {
  id: string;
  cell_type: string;
  source: string;
  metadata: Record<string, unknown>;
  execution_count: number | null;
  outputs: unknown[];
};
const markdownGroupMetadataKey = "didaction_markdown_group";
const id: Field = { type: "string", minLength: 1, maxLength: 128 };
const source: Field = { type: "string", maxLength: 64000 };
const index: Field = { type: "integer", minimum: 0, maximum: 2047 };
const timeout: Field = { type: "integer", minimum: 1, maximum: 120000 };
const definitions: ToolDefinition[] = [];
function define(
  name: string,
  description: string,
  properties: Record<string, Field> = {},
  required = Object.keys(properties),
  readOnly = false,
  execution = false,
) {
  definitions.push({
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: execution,
    },
  });
}
define(
  "list_microscopes",
  "List microscope IDs and titles for a cell.",
  { cell_id: id },
  undefined,
  true,
);
define(
  "open_microscope",
  "Load one microscope in this notebook window, replacing its current view. Does not modify notebook contents.",
  {
    cell_id: id,
    microscope_id: { type: "string", minLength: 7, maxLength: 7 },
  },
  undefined,
  true,
);
define(
  "close_microscope",
  "Return this window to notebook mode.",
  {},
  [],
  true,
);
const microScope = {
  cell_id: id,
  microscope_id: { type: "string", minLength: 7, maxLength: 7 } as Field,
};
define(
  "open_playground",
  "Open a step's separate playground code in a temporary one-cell notebook with a fresh kernel. Driver only. Does not execute automatically.",
  { ...microScope, step_index: { type: "integer", minimum: 0, maximum: 63 } },
);
define(
  "close_playground",
  "Exit the temporary notebook and destroy its kernel; discard edits and outputs.",
  {},
);
define(
  "read_playground",
  "Read the currently displayed temporary notebook and its outputs.",
  {},
  [],
  true,
);
define(
  "execute_playground",
  "Execute the temporary cell, optionally replacing its source first. Driver-only unsafe local execution.",
  { source },
  [],
  false,
  true,
);
const shortId: Field = { type: "string", minLength: 1, maxLength: 64 };
const title: Field = { type: "string", minLength: 1, maxLength: 128 };
const annotation: Field = {
  type: "object",
  additionalProperties: false,
  required: ["id", "start_line", "end_line", "text"],
  properties: {
    id: shortId,
    start_line: { type: "integer", minimum: 1, maximum: 64001 },
    end_line: { type: "integer", minimum: 1, maximum: 64001 },
    start_column: { type: "integer", minimum: 1, maximum: 64001 },
    end_column: { type: "integer", minimum: 1, maximum: 64001 },
    text: { type: "string", minLength: 1, maxLength: 4096 },
    color: { type: "string", enum: ["blue", "blue-light", "blue-deep"] },
  },
};
const overlayBounds: Field = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "width", "height"],
  properties: {
    x: { type: "integer", minimum: 0, maximum: 975 },
    y: { type: "integer", minimum: 0, maximum: 975 },
    width: { type: "integer", minimum: 25, maximum: 1000 },
    height: { type: "integer", minimum: 25, maximum: 1000 },
  },
};
const walkthroughOverlay: Field = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "bounds"],
  properties: {
    id: shortId,
    kind: {
      type: "string",
      enum: [
        "code",
        "markdown",
        "annotations",
        "playground",
        "graphics_controls",
      ],
    },
    bounds: overlayBounds,
    markdown: source,
  },
};
const walkthrough: Field = {
  type: "object",
  additionalProperties: false,
  required: ["title", "steps"],
  properties: {
    title,
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "code", "markdown"],
        properties: {
          id: shortId,
          title,
          code: source,
          markdown: source,
          playground_code: { ...source, minLength: 1 },
          graphics: {
            type: "object",
            additionalProperties: false,
            required: ["language", "source", "description"],
            properties: {
              language: { type: "string", enum: ["assemblyscript-rgba-1"] },
              source: {
                ...source,
                minLength: 1,
                description:
                  "AssemblyScript exports: init(width:i32,height:i32,stepIndex:i32):void; render(width:i32,height:i32,elapsed:f64,delta:f64):usize returns a pointer to width*height*4 unpremultiplied RGBA bytes; dispose():void. Physical pixels, seconds, max 1024x768; fixed 16 MiB stub runtime, reuse allocations. Only memory and abort imports are allowed; no browser/kernel APIs.",
              },
              description: { type: "string", minLength: 1, maxLength: 1024 },
              artifact: {
                type: "string",
                minLength: 4,
                maxLength: 80,
                pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*\\.ts$",
                description:
                  "Save an owned graphics source attachment as <microscope-path>.<artifact>, e.g. orbit.ts. Updated/deleted with the microscope and included in workspace export.",
              },
            },
          },
          annotations: { type: "array", maxItems: 32, items: annotation },
          overlays: {
            type: "array",
            maxItems: 32,
            items: walkthroughOverlay,
            description:
              "Workspace-relative overlays in thousandths (0..1000). Markdown may appear multiple times; navigation remains fixed above the stage.",
          },
        },
      },
    },
  },
};
define(
  "create_microscope",
  "Create a complete microscope and its walkthrough in one operation. A nonempty walkthrough is required; playground_code optionally supplies separate self-contained executable code per step.",
  { cell_id: id, title, walkthrough },
);
define(
  "update_microscope",
  "Replace the entire microscope content and title, preserving its ID and owning cell.",
  { ...microScope, walkthrough },
);
define(
  "set_microscope_walkthrough",
  "Replace a microscope's complete walkthrough. Display-only code, ordered steps, Markdown and inclusive one-based line annotations, optionally narrowed to one-based character columns on one line. Driver-only; saved in its sidecar.",
  { ...microScope, walkthrough },
);
define(
  "read_microscope",
  "Read the saved microscope document and its walkthrough.",
  microScope,
  undefined,
  true,
);
define(
  "focus_microscope_step",
  "Open this microscope at a zero-based step index, clearing temporary annotation focus. Local presentation only; opt-in followers follow the driver.",
  { ...microScope, step_index: { type: "integer", minimum: 0, maximum: 63 } },
  undefined,
  true,
);
define(
  "focus_microscope_annotation",
  "Open a step and pulse the named annotation's code range. Does not change saved annotations or execute code.",
  {
    ...microScope,
    step_index: { type: "integer", minimum: 0, maximum: 63 },
    annotation_id: shortId,
  },
  undefined,
  true,
);
define(
  "clear_microscope_focus",
  "Clear temporary annotation focus in the currently open microscope; keep the current step and saved annotations.",
  microScope,
  undefined,
  true,
);
define(
  "set_cell_visibility",
  "Collapse or expand a cell without modifying notebook contents.",
  { cell_id: id, collapsed: { type: "boolean" } },
);
define(
  "set_output_visibility",
  "Set presentation-only output mode; preserves all outputs.",
  {
    cell_id: id,
    mode: { type: "string", enum: ["expanded", "windowed", "collapsed"] },
  },
);
define(
  "capture_cell",
  "Scroll to a cell and capture its currently rendered visible portion as PNG. Does not expand hidden content. Tall cells may be clipped; see clipped in result.",
  { cell_id: id },
);
define(
  "capture_microscope_step",
  "Capture the currently rendered microscope stage as PNG for visual design feedback. Includes the graphics background and all overlays, but not fixed navigation.",
  microScope,
  undefined,
  true,
);
define(
  "highlight_cell",
  "Add a separate pulsing agent border in this notebook view. Click the cell or call clear_cell_highlight to dismiss. Does not select or edit the cell. In-memory only.",
  {
    cell_id: id,
    color: { type: "string", enum: ["blue", "blue-light", "blue-deep"] },
  },
  ["cell_id"],
);
define(
  "clear_cell_highlight",
  "Clear a cell's agent border in this view without changing its selection or contents.",
  { cell_id: id },
);
define(
  "read_notebook",
  "Read committed cells, IDs, sources and outputs of the configured notebook.",
  {},
  [],
  true,
);
define(
  "read_cell",
  "Read one committed cell by stable ID.",
  { cell_id: id },
  undefined,
  true,
);
define(
  "insert_cell",
  "Insert before_cell_id or after_cell_id (stable across reorder), or at an explicitly absolute zero-based index. Supply exactly one position.",
  {
    index,
    before_cell_id: id,
    after_cell_id: id,
    cell_type: { type: "string", enum: ["code", "markdown", "raw"] },
    source,
  },
  ["cell_type", "source"],
);
define(
  "overwrite_cell_source",
  "Replace a cell's entire source, preserving its ID and type.",
  { cell_id: id, source },
);
define(
  "edit_cell_source",
  "Literal find/replace. Match must be unique unless replace_all is true.",
  {
    cell_id: id,
    old_string: { ...source, minLength: 1 },
    new_string: source,
    replace_all: { type: "boolean" },
  },
  ["cell_id", "old_string", "new_string"],
);
define(
  "set_markdown_code_group",
  "Visually combine a code cell with the immediately preceding Markdown cell inside one shared notebook cell boundary. Persists as code-cell metadata; set grouped false to separate them.",
  { cell_id: id, grouped: { type: "boolean" } },
);
define(
  "move_cell",
  "Move before_cell_id or after_cell_id, or to an explicitly absolute zero-based final index. Supply exactly one position.",
  {
    cell_id: id,
    index,
    before_cell_id: id,
    after_cell_id: id,
  },
  ["cell_id"],
);
define("delete_cell", "Delete one cell and its outputs by stable ID.", {
  cell_id: id,
});
define(
  "clear_cell_output",
  "Clear a code cell's outputs and execution count.",
  { cell_id: id },
);
define(
  "execute_cell",
  "Execute a code cell in the local kernel and await committed outputs. Unsafe code execution.",
  { cell_id: id, timeout_ms: timeout },
  ["cell_id"],
  false,
  true,
);
define(
  "insert_execute_code_cell",
  "Insert then execute code. Insertion remains on execution failure; never blindly retry.",
  { index, before_cell_id: id, after_cell_id: id, source, timeout_ms: timeout },
  ["source"],
  false,
  true,
);
define("interrupt_kernel", "Interrupt current local kernel execution.");
define(
  "restart_notebook",
  "Restart the configured kernel; in-memory variables are lost.",
);
class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function parse(
  definition: ToolDefinition,
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ToolError("invalid_input", "Arguments must be an object");
  const values = input as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(values)).length > 512000)
    throw new ToolError("bounds_exceeded", "Tool input exceeds limit");
  for (const key of definition.inputSchema.required)
    if (!Object.hasOwn(values, key))
      throw new ToolError("invalid_input", `Missing argument: ${key}`);
  for (const [key, value] of Object.entries(values)) {
    const field = Object.hasOwn(definition.inputSchema.properties, key)
      ? definition.inputSchema.properties[key]
      : undefined;
    if (!field) throw new ToolError("invalid_input", "Unknown argument");
    if (field.type === "string") {
      if (
        typeof value !== "string" ||
        value.length < (field.minLength ?? 0) ||
        new TextEncoder().encode(value).length > (field.maxLength ?? 64000) ||
        (field.enum && !field.enum.includes(value))
      )
        throw new ToolError("invalid_input", `Invalid argument: ${key}`);
    } else if (field.type === "integer") {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < (field.minimum ?? 0) ||
        value > (field.maximum ?? 2047)
      )
        throw new ToolError("invalid_input", `Invalid argument: ${key}`);
    } else if (field.type === "object") {
      parse(
        {
          ...definition,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: field.properties!,
            required: field.required!,
          },
        },
        value,
      );
    } else if (field.type === "array") {
      if (
        !Array.isArray(value) ||
        value.length < (field.minItems ?? 0) ||
        value.length > (field.maxItems ?? 64)
      )
        throw new ToolError("invalid_input", `Invalid array: ${key}`);
      for (const item of value)
        parse(
          {
            ...definition,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: { item: field.items! },
              required: ["item"],
            },
          },
          { item },
        );
    } else if (typeof value !== "boolean")
      throw new ToolError("invalid_input", `Invalid argument: ${key}`);
  }
  return values;
}
function answer(value: Record<string, unknown>, isError = false): ToolResult {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > 600000)
    return answer(
      {
        ok: false,
        error: {
          code: "bounds_exceeded",
          message:
            "Result exceeds tool limit; use read_cell. A mutation may already be committed.",
        },
      },
      true,
    );
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
    isError,
  };
}
/** Transport-independent tool catalog and invocation; adapters never construct commands. */
export class NotebookTools implements NotebookToolInvoker {
  constructor(
    private readonly transaction: Transaction,
    private readonly snapshot: () => NotebookSnapshot,
    private readonly assertReady: () => void = () => {},
    private readonly interrupt?: Execute,
    private readonly view?: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<ToolResult>,
  ) {}
  listTools(): ToolDefinition[] {
    return structuredClone(definitions);
  }
  async callTool(name: string, input: unknown): Promise<ToolResult> {
    try {
      const definition = definitions.find((tool) => tool.name === name);
      if (!definition)
        throw new ToolError("unsupported_operation", "Unknown notebook tool");
      const args = parse(definition, input);
      if (
        ["insert_cell", "insert_execute_code_cell", "move_cell"].includes(
          name,
        ) &&
        ["index", "before_cell_id", "after_cell_id"].filter(
          (key) => args[key] !== undefined,
        ).length !== 1
      )
        throw new ToolError(
          "invalid_input",
          "Supply exactly one of before_cell_id, after_cell_id or absolute index",
        );
      if (
        [
          "set_cell_visibility",
          "open_playground",
          "close_playground",
          "read_playground",
          "execute_playground",
          "set_output_visibility",
          "capture_cell",
          "capture_microscope_step",
          "highlight_cell",
          "clear_cell_highlight",
          "open_microscope",
          "close_microscope",
          "focus_microscope_step",
          "focus_microscope_annotation",
          "clear_microscope_focus",
        ].includes(name)
      ) {
        if (!this.view)
          throw new ToolError(
            "unsupported_operation",
            "Mounted notebook view unavailable",
          );
        return await this.view(name, args);
      }
      const run = async (execute: Execute) => {
        if (name !== "interrupt_kernel") this.assertReady();
        const send = async (
          type: string,
          values: Record<string, unknown> = {},
        ) => {
          const command: NotebookCommand = {
            protocol_version: 1,
            command_id: crypto.randomUUID(),
            idempotency_key: crypto.randomUUID(),
            expected_revision:
              type === "interrupt_kernel" ? null : this.snapshot().revision,
            timeout_ms: (args.timeout_ms as number | undefined) ?? 30000,
            ...values,
            type,
          };
          const result = JSON.parse(
            await execute(JSON.stringify(command)),
          ) as CommandResult;
          if (result.error)
            throw new ToolError(
              result.error.code,
              "Notebook operation failed; inspect the notebook before retrying",
            );
          return result;
        };
        if (name === "interrupt_kernel" || name === "restart_notebook") {
          await send(
            name === "restart_notebook" ? "restart_kernel" : "interrupt_kernel",
          );
          return answer({ ok: true, revision: this.snapshot().revision });
        }
        await send("query", { query: "full" });
        const cells = this.snapshot().cells as Cell[];
        const cell =
          args.cell_id === undefined
            ? undefined
            : cells.find((cell) => cell.id === args.cell_id);
        if (args.cell_id !== undefined && !cell)
          throw new ToolError(
            "invalid_input",
            "Cell ID does not exist; read_notebook to refresh IDs",
          );
        const code =
          name === "execute_cell"
            ? cell?.source
            : name === "insert_execute_code_cell"
              ? args.source
              : undefined;
        if (
          typeof code === "string" &&
          /^\s*(?:!|%pip\b|%conda\b|%%(?:bash|sh)\b)/m.test(code)
        ) {
          throw new ToolError(
            "execution_rejected",
            "Shell and package-install magics are not exposed by notebook tools",
          );
        }
        const publicCell = (cell: Cell) => {
          const cellIndex = cells.findIndex(
            (candidate) => candidate.id === cell.id,
          );
          const group = cell.metadata?.[markdownGroupMetadataKey] as
            | { schema_version?: unknown; markdown_cell_id?: unknown }
            | undefined;
          return {
            id: cell.id,
            cell_type: cell.cell_type,
            source: cell.source,
            markdown_grouped:
              cell.cell_type === "code" &&
              group?.schema_version === 1 &&
              cellIndex > 0 &&
              cells[cellIndex - 1]?.cell_type === "markdown" &&
              group.markdown_cell_id === cells[cellIndex - 1]?.id,
            execution_count: cell.execution_count,
            outputs: cell.outputs,
          };
        };
        if (name === "read_notebook")
          return answer({
            ok: true,
            revision: this.snapshot().revision,
            cells: cells.map(publicCell),
          });
        if (name === "read_cell")
          return answer({
            ok: true,
            revision: this.snapshot().revision,
            cell: publicCell(cell!),
          });
        if (name === "list_microscopes") {
          const metadata = (
            cell as Cell & { metadata?: Record<string, unknown> }
          ).metadata;
          return answer({
            ok: true,
            cell_id: cell!.id,
            microscopes:
              (
                metadata?.didaction_microscopes as
                  | { items?: unknown[] }
                  | undefined
              )?.items ?? [],
          });
        }
        if (
          name === "set_microscope_walkthrough" ||
          name === "update_microscope" ||
          name === "read_microscope"
        ) {
          const result = await send(
            name === "update_microscope" ? "set_microscope_walkthrough" : name,
            {
              cell_id: cell!.id,
              microscope_id: args.microscope_id,
              ...(name !== "read_microscope"
                ? { walkthrough: args.walkthrough }
                : {}),
            },
          );
          return answer({
            ok: true,
            revision: this.snapshot().revision,
            microscope: result.microscope,
          });
        }
        if (name === "create_microscope") {
          const microscope_id = crypto
            .randomUUID()
            .replaceAll("-", "")
            .slice(0, 7);
          await send("create_microscope", {
            cell_id: cell!.id,
            microscope_id,
            title: args.title,
            walkthrough: args.walkthrough,
          });
          return answer({
            ok: true,
            cell_id: cell!.id,
            microscope_id,
            title: args.title,
            revision: this.snapshot().revision,
          });
        }
        let affectedId = cell?.id;
        const modify = (change: Record<string, unknown>) =>
          send("modify_cells", { changes: [change] });
        const position = (operation: "insert" | "move") =>
          args.index !== undefined
            ? { operation, index: args.index }
            : {
                operation: `${operation}_relative`,
                anchor_cell_id: args.before_cell_id ?? args.after_cell_id,
                after: args.after_cell_id !== undefined,
              };
        switch (name) {
          case "insert_cell":
          case "insert_execute_code_cell": {
            if ((args.index as number) > cells.length)
              throw new ToolError(
                "invalid_input",
                "Insert index exceeds cell count",
              );
            affectedId = crypto.randomUUID();
            await modify({
              ...position("insert"),
              cell: {
                id: affectedId,
                cell_type: name === "insert_cell" ? args.cell_type : "code",
                source: args.source,
                metadata: {},
                execution_count: null,
                outputs: [],
              },
            });
            if (name === "insert_execute_code_cell") {
              try {
                await send("execute_cell", { cell_id: affectedId });
              } catch {
                return answer(
                  {
                    ok: false,
                    cell_id: affectedId,
                    inserted: true,
                    error: {
                      code: "execution_failed",
                      message:
                        "Cell inserted; execution did not complete successfully. Inspect it before retrying.",
                    },
                  },
                  true,
                );
              }
            }
            break;
          }
          case "overwrite_cell_source":
            await modify({
              operation: "update",
              cell_id: affectedId,
              source: args.source,
            });
            break;
          case "edit_cell_source": {
            const pieces = cell!.source.split(args.old_string as string);
            const replacement = args.new_string as string;
            if (
              new TextEncoder().encode(cell!.source).length +
                (pieces.length - 1) *
                  new TextEncoder().encode(replacement).length >
              256000
            )
              throw new ToolError(
                "bounds_exceeded",
                "Edited source exceeds limit",
              );
            if (
              pieces.length === 1 ||
              (!args.replace_all && pieces.length !== 2)
            )
              throw new ToolError(
                "edit_conflict",
                "Text must match exactly once unless replace_all is true",
              );
            await modify({
              operation: "update",
              cell_id: affectedId,
              source: pieces.join(args.new_string as string),
            });
            break;
          }
          case "set_markdown_code_group": {
            if (cell!.cell_type !== "code")
              throw new ToolError(
                "invalid_input",
                "Only code cells can be grouped with Markdown",
              );
            const cellIndex = cells.findIndex(
              (candidate) => candidate.id === affectedId,
            );
            if (
              args.grouped &&
              (cellIndex === 0 ||
                cells[cellIndex - 1]?.cell_type !== "markdown")
            )
              throw new ToolError(
                "invalid_input",
                "The code cell must immediately follow a Markdown cell",
              );
            const metadata = structuredClone(cell!.metadata ?? {});
            if (args.grouped)
              metadata[markdownGroupMetadataKey] = {
                schema_version: 1,
                markdown_cell_id: cells[cellIndex - 1]!.id,
              };
            else delete metadata[markdownGroupMetadataKey];
            await modify({
              operation: "update",
              cell_id: affectedId,
              metadata,
            });
            break;
          }
          case "move_cell":
            if ((args.index as number) >= cells.length)
              throw new ToolError(
                "invalid_input",
                "Move index exceeds cell count",
              );
            await modify({
              ...position("move"),
              cell_id: affectedId,
            });
            break;
          case "delete_cell":
            await modify({ operation: "delete", cell_id: affectedId });
            break;
          case "clear_cell_output":
            await modify({ operation: "clear_outputs", cell_id: affectedId });
            break;
          case "execute_cell":
            await send("execute_cell", { cell_id: affectedId });
            break;
        }
        const updated = (this.snapshot().cells as Cell[]).find(
          (cell) => cell.id === affectedId,
        );
        return answer({
          ok: true,
          revision: this.snapshot().revision,
          cell_id: affectedId,
          ...(updated ? { cell: publicCell(updated) } : {}),
        });
      };
      return name === "interrupt_kernel" && this.interrupt
        ? await run(this.interrupt)
        : await this.transaction(run);
    } catch (error) {
      return answer(
        {
          ok: false,
          error: {
            code: error instanceof ToolError ? error.code : "transport_error",
            message:
              error instanceof ToolError
                ? error.message
                : "Notebook request failed or local edits are pending; save/reconnect and inspect before retrying",
          },
        },
        true,
      );
    }
  }
}
