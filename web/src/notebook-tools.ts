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
  type: "string" | "integer" | "boolean";
  maxLength?: number;
  minLength?: number;
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
  execution_count: number | null;
  outputs: unknown[];
};
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
  if (new TextEncoder().encode(JSON.stringify(values)).length > 200000)
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
    } else if (typeof value !== "boolean")
      throw new ToolError("invalid_input", `Invalid argument: ${key}`);
  }
  return values;
}
function answer(value: Record<string, unknown>, isError = false): ToolResult {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > 200000)
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
          "set_output_visibility",
          "capture_cell",
          "highlight_cell",
          "clear_cell_highlight",
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
        const publicCell = (cell: Cell) => ({
          id: cell.id,
          cell_type: cell.cell_type,
          source: cell.source,
          execution_count: cell.execution_count,
          outputs: cell.outputs,
        });
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
