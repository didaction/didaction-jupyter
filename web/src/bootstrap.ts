import init, { mountNotebook, NotebookApplication } from "../pkg/notebook_wasm";
import {
  CommandGateway,
  createQueuedNotebookDispatcher,
} from "./command-gateway";
import { GatewayNotebookTransport } from "./gateway-client";
import type { NotebookCommand, NotebookSnapshot } from "./types";
import { installWebMcp } from "./webmcp";
import { NotebookTools, type Transaction } from "./notebook-tools";

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
  const configResponse = await fetch("/api/v1/config", {
    headers: { Accept: "application/json" },
  });
  if (!configResponse.ok)
    throw new Error("Gateway startup configuration unavailable");
  const startup = (await configResponse.json()) as {
    path: string;
    kernel: string;
  };
  const transport = new GatewayNotebookTransport();
  const setup = await transport.setup(
    command("setup", {
      path: startup.path,
      kernel: startup.kernel,
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
  const dispatchEguiCommand = createQueuedNotebookDispatcher(gateway, () =>
    Number(
      (JSON.parse(wasm.publicSnapshot()) as { snapshot: NotebookSnapshot })
        .snapshot.revision,
    ),
  );
  const mounted = await mountNotebook(
    "notebook-canvas",
    JSON.stringify(snapshot),
    dispatchEguiCommand,
  );
  const externalExecute = async (serialized: string) => {
    try {
      const result = await gateway.execute(serialized, (progress) =>
        mounted.applyExternalResult(JSON.stringify(progress), true),
      );
      mounted.applyExternalResult(result, false);
      return result;
    } catch (error) {
      const command = JSON.parse(serialized) as NotebookCommand;
      mounted.applyExternalResult(
        JSON.stringify({
          protocol_version: 1,
          command_id: command.command_id,
          idempotency_key: command.idempotency_key,
          base_revision: null,
          committed_revision: null,
          snapshot: null,
          error: {
            code: "transport_error",
            message:
              "Tool command failed; reconnect and inspect notebook before retrying",
            retryable: true,
          },
        }),
        false,
      );
      throw error;
    }
  };
  const transaction: Transaction = (task) =>
    dispatchEguiCommand.transaction(async () => {
      mounted.assertExternalReady();
      mounted.setExternalBusy(true);
      try {
        return await task(externalExecute);
      } finally {
        mounted.setExternalBusy(false);
      }
    });
  const interruptExecute = async (serialized: string) => {
    // Out-of-band interruption cannot advance a running command's validator revision.
    const validation = new NotebookApplication(
      JSON.stringify(
        (JSON.parse(wasm.publicSnapshot()) as { snapshot: NotebookSnapshot })
          .snapshot,
      ),
    );
    try {
      return await new CommandGateway(validation, transport).execute(
        serialized,
      );
    } finally {
      validation.dispose();
    }
  };
  const tools = new NotebookTools(
    transaction,
    () =>
      (JSON.parse(wasm.publicSnapshot()) as { snapshot: NotebookSnapshot })
        .snapshot,
    () => {},
    interruptExecute,
  );
  const webmcp = installWebMcp(tools);
  const hasWebMcp = webmcp.available;
  status.textContent = hasWebMcp
    ? "Connected · WebMCP ready"
    : "Connected · WebMCP unavailable";
  document.documentElement.dataset.webmcp = hasWebMcp
    ? "available"
    : "unavailable";
  const shell = document.querySelector<HTMLElement>("#notebook-shell")!;
  const resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  });
  resizeObserver.observe(shell);
  window.addEventListener(
    "beforeunload",
    () => {
      resizeObserver.disconnect();
      webmcp.dispose();
      mounted.dispose();
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
