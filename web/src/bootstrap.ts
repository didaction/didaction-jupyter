import init, { mountNotebook, NotebookApplication } from "../pkg/notebook_wasm";
import { CommandGateway } from "./command-gateway";
import { McpNotebookTransport } from "./mcp-client";
import type { NotebookCommand, NotebookSnapshot } from "./types";
import { installWebMcp } from "./webmcp";

const status = document.querySelector<HTMLOutputElement>("#connection-status")!;
const fatal = document.querySelector<HTMLElement>("#fatal-error")!;
const command = (
  type: string,
  values: Record<string, unknown> = {},
): NotebookCommand => ({
  protocol_version: 1,
  command_id: crypto.randomUUID(),
  idempotency_key: crypto.randomUUID(),
  expected_revision: null,
  timeout_ms: 30_000,
  type,
  ...values,
});

async function boot(): Promise<void> {
  await init();
  const transport = new McpNotebookTransport();
  const setup = await transport.setup(
    command("setup", {
      path: "acceptance-demo-v1.ipynb",
      kernel: "python3",
      create: true,
    }),
  );
  if (setup.error || !setup.snapshot)
    throw new Error(
      setup.error?.message ?? "Gateway returned no notebook snapshot",
    );
  const snapshot = setup.snapshot as NotebookSnapshot;
  const wasm = new NotebookApplication(JSON.stringify(snapshot));
  const gateway = new CommandGateway(wasm, transport);
  const hasWebMcp = installWebMcp(
    gateway,
    () =>
      (JSON.parse(wasm.publicSnapshot()) as { snapshot: NotebookSnapshot })
        .snapshot.revision,
  );
  status.textContent = hasWebMcp
    ? "Connected · WebMCP ready"
    : "Connected · WebMCP unavailable";
  document.documentElement.dataset.webmcp = hasWebMcp
    ? "available"
    : "unavailable";
  await mountNotebook(
    "notebook-canvas",
    JSON.stringify(snapshot),
    (serialized: string) => gateway.execute(serialized),
  );
  window.addEventListener(
    "beforeunload",
    () => {
      wasm.dispose();
      void transport.close();
    },
    { once: true },
  );
}

boot().catch((error: unknown) => {
  status.textContent = "Disconnected";
  fatal.hidden = false;
  fatal.querySelector("p")!.textContent =
    error instanceof Error ? error.message : "Unknown startup failure";
});
