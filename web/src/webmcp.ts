import type {
  NotebookToolInvoker,
  ToolDefinition,
  ToolResult,
} from "./notebook-tools";
export type ModelContext = {
  registerTool(
    tool: ToolDefinition & { execute(input: unknown): Promise<ToolResult> },
  ): void;
  unregisterTool?(name: string): void;
};
/** Registration adapter only: no notebook command construction or transport. */
export function installWebMcp(
  tools: NotebookToolInvoker,
  context: ModelContext | undefined = (
    navigator as Navigator & { modelContext?: ModelContext }
  ).modelContext,
): { available: boolean; dispose(): void } {
  const registered: string[] = [];
  const dispose = () => {
    for (const name of registered.splice(0)) context?.unregisterTool?.(name);
  };
  if (!context?.registerTool) return { available: false, dispose };
  try {
    for (const tool of tools.listTools()) {
      context.registerTool({
        ...tool,
        execute: (input) => tools.callTool(tool.name, input),
      });
      registered.push(tool.name);
    }
    return { available: true, dispose };
  } catch {
    dispose();
    return { available: false, dispose };
  }
}
