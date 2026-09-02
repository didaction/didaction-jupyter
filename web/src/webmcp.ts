import type {
  NotebookToolInvoker,
  ToolDefinition,
  ToolResult,
} from "./notebook-tools";
export type ModelContext = {
  registerTool(
    tool: ToolDefinition & { execute(input: unknown): Promise<ToolResult> },
    options?: { signal: AbortSignal },
  ): void | Promise<void>;
  unregisterTool?(name: string): void;
};
/** Registration adapter only: no notebook command construction or transport. */
export async function installWebMcp(
  tools: NotebookToolInvoker,
  context: ModelContext | undefined = (typeof document !== "undefined"
    ? (document as Document & { modelContext?: ModelContext }).modelContext
    : undefined) ??
    (typeof navigator !== "undefined"
      ? (navigator as Navigator & { modelContext?: ModelContext }).modelContext
      : undefined),
): Promise<{ available: boolean; dispose(): void }> {
  const registered: string[] = [];
  const controller = new AbortController();
  const dispose = () => {
    controller.abort();
    for (const name of registered.splice(0)) {
      try {
        context?.unregisterTool?.(name);
      } catch {
        // Abort-signal implementations may already have removed the tool.
      }
    }
  };
  if (!context?.registerTool) return { available: false, dispose };
  try {
    for (const tool of tools.listTools()) {
      await context.registerTool(
        {
          ...tool,
          execute: (input) => tools.callTool(tool.name, input),
        },
        { signal: controller.signal },
      );
      registered.push(tool.name);
    }
    return { available: true, dispose };
  } catch {
    dispose();
    return { available: false, dispose };
  }
}
