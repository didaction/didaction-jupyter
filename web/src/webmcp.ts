import type { CommandGateway } from "./command-gateway";

type ModelContext = {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: object;
    annotations?: object;
    execute(input: Record<string, unknown>): Promise<unknown>;
  }): void;
};

const bounded = { type: "object", additionalProperties: false } as const;
export function installWebMcp(
  gateway: CommandGateway,
  revision: () => number,
  startup: { path: string; kernel: string },
): boolean {
  const context = (navigator as Navigator & { modelContext?: ModelContext })
    .modelContext;
  if (!context?.registerTool) return false;
  const register = (
    name: string,
    type: string,
    properties: object,
    required: string[],
    readOnly: boolean,
  ) =>
    context.registerTool({
      name,
      description: `Validated local notebook ${type.replaceAll("_", " ")}`,
      inputSchema: { ...bounded, properties, required },
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
      execute: async (input) => {
        const values =
          type === "setup"
            ? { path: startup.path, kernel: startup.kernel, create: true }
            : input;
        const command = {
          protocol_version: 1,
          command_id: crypto.randomUUID(),
          idempotency_key: crypto.randomUUID(),
          expected_revision: revision(),
          timeout_ms: 30_000,
          type,
          ...values,
        };
        const result = JSON.parse(
          await gateway.execute(JSON.stringify(command)),
        ) as { error?: unknown; snapshot?: unknown };
        return {
          ok: !result.error,
          error: result.error,
          snapshot: result.snapshot,
        };
      },
    });
  register(
    "notebook_query",
    "query",
    { query: { type: "string", enum: ["summary", "cells", "full"] } },
    ["query"],
    true,
  );
  register(
    "notebook_modify_cells",
    "modify_cells",
    {
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: { type: "object" },
      },
    },
    ["changes"],
    false,
  );
  register(
    "notebook_execute",
    "execute_cell",
    { cell_id: { type: "string", maxLength: 128 } },
    ["cell_id"],
    false,
  );
  register("notebook_setup", "setup", {}, [], false);
  return true;
}
