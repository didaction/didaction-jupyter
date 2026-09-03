import type { Page } from "@playwright/test";
export async function installMicroscopeTools(page: Page) {
  await page.addInitScript(() => {
    const tools: Record<string, { execute(args: unknown): Promise<unknown> }> =
      {};
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: {
          name: string;
          execute(args: unknown): Promise<unknown>;
        }) {
          tools[tool.name] = tool;
        },
        unregisterTool(name: string) {
          delete tools[name];
        },
      },
    });
    Object.assign(window, { microscopeTestTools: tools });
  });
}
export async function microscopeCall(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
) {
  return page.evaluate(
    async ({ name, args }) => {
      const tools = (
        window as unknown as {
          microscopeTestTools: Record<
            string,
            {
              execute(args: unknown): Promise<{
                isError: boolean;
                structuredContent: Record<string, unknown>;
                content: Array<Record<string, unknown>>;
              }>;
            }
          >;
        }
      ).microscopeTestTools;
      return tools[name]!.execute(args);
    },
    { name, args },
  );
}
