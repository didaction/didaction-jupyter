import init, { mountNotebook, NotebookApplication } from "../pkg/notebook_wasm";
import {
  CommandGateway,
  createQueuedNotebookDispatcher,
} from "./command-gateway";
import { GatewayNotebookTransport } from "./gateway-client";
import type { NotebookCommand, NotebookSnapshot } from "./types";
import { installWebMcp } from "./webmcp";
import { NotebookTools, type Transaction } from "./notebook-tools";
import { installExplorer } from "./explorer";
import { WorkspaceTools, type OpenNotebook } from "./workspace-tools";

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

async function createContext(
  startup: { path: string; kernel: string },
  create = false,
): Promise<OpenNotebook> {
  const transport = new GatewayNotebookTransport(
    "/api/v1/commands",
    startup.path,
  );
  const setup = await transport.setup(
    command("setup", {
      path: startup.path,
      kernel: startup.kernel,
      create,
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
  let mounted: Awaited<ReturnType<typeof mountNotebook>> | undefined;
  const syncWorkspaceVisibility = () =>
    mounted?.setWorkspaceVisible(
      !document.querySelector<HTMLElement>("#file-explorer")!.hidden,
    );
  window.addEventListener("workspace-visibility", syncWorkspaceVisibility);
  const externalExecute = async (serialized: string) => {
    try {
      const result = await gateway.execute(serialized, (progress) =>
        mounted?.applyExternalResult(JSON.stringify(progress), true),
      );
      mounted?.applyExternalResult(result, false);
      return result;
    } catch (error) {
      const command = JSON.parse(serialized) as NotebookCommand;
      mounted?.applyExternalResult(
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
      mounted?.assertExternalReady();
      mounted?.setExternalBusy(true);
      try {
        return await task(externalExecute);
      } finally {
        mounted?.setExternalBusy(false);
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
    (name, args) =>
      dispatchEguiCommand.transaction(async () => {
        if (!mounted)
          throw new Error(
            "Select this notebook with open_notebook before using view tools",
          );
        const id = args.cell_id as string;
        if (name !== "capture_cell") {
          mounted.cellView(
            id,
            name === "set_cell_visibility" ? "cell" : "output",
            String(name === "set_cell_visibility" ? args.collapsed : args.mode),
          );
          const result = { ok: true, cell_id: id, ...args };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          };
        }
        mounted.cellView(id, "capture", "");
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const raw = mounted.takeCellCapture();
          if (!raw) continue;
          const capture = JSON.parse(raw) as {
            width: number;
            height: number;
            rgba: string;
            clipped: boolean;
          };
          const canvas = document.createElement("canvas");
          canvas.width = capture.width;
          canvas.height = capture.height;
          const pixels = Uint8ClampedArray.from(atob(capture.rgba), (byte) =>
            byte.charCodeAt(0),
          );
          canvas
            .getContext("2d")!
            .putImageData(
              new ImageData(pixels, capture.width, capture.height),
              0,
              0,
            );
          const data = canvas.toDataURL("image/png").split(",")[1];
          if (!data || data.length > 2_000_000)
            throw new Error("Cell capture exceeds image limit");
          const result = {
            ok: true,
            cell_id: id,
            width: capture.width,
            height: capture.height,
            clipped: capture.clipped,
          };
          return {
            content: [
              { type: "image" as const, mimeType: "image/png" as const, data },
            ],
            structuredContent: result,
            isError: false,
          };
        }
        throw new Error(
          "Cell capture timed out; keep the notebook tab visible",
        );
      }),
  );
  const deactivate = () => {
    if (!mounted) return;
    mounted.dispose();
    mounted = undefined;
    const old = document.querySelector<HTMLCanvasElement>("#notebook-canvas")!;
    const fresh = old.cloneNode(false) as HTMLCanvasElement;
    old.replaceWith(fresh);
    document.querySelector<HTMLElement>("#notebook-shell")!.hidden = true;
  };
  return {
    tools,
    activeContext: () =>
      mounted
        ? (JSON.parse(mounted.activeContext()) as Record<string, unknown>)
        : null,
    path: () =>
      JSON.parse(wasm.publicSnapshot()).snapshot.notebook.path as string,
    ready: () => mounted?.assertExternalReady(),
    activate: async () => {
      document.querySelector<HTMLElement>("#notebook-shell")!.hidden = false;
      mounted = await mountNotebook(
        "notebook-canvas",
        JSON.stringify(JSON.parse(wasm.publicSnapshot()).snapshot),
        dispatchEguiCommand,
        () => {
          document
            .querySelector<HTMLButtonElement>("#explorer-toggle")!
            .click();
          return !document.querySelector<HTMLElement>("#file-explorer")!.hidden;
        },
      );
      const url = new URL(location.href);
      syncWorkspaceVisibility();
      const activePath = JSON.parse(wasm.publicSnapshot()).snapshot.notebook
        .path as string;
      url.searchParams.set("notebook", activePath);
      history.replaceState(null, "", url);
      document
        .querySelectorAll<HTMLElement>("#notebook-files button")
        .forEach((button) => {
          if (button.title === activePath)
            button.setAttribute("aria-current", "page");
          else button.removeAttribute("aria-current");
        });
    },
    deactivate,
    dispose: () => {
      window.removeEventListener(
        "workspace-visibility",
        syncWorkspaceVisibility,
      );
      deactivate();
      wasm.dispose();
      void transport.close();
    },
  };
}

async function boot(): Promise<void> {
  await init();
  const response = await fetch("/api/v1/config");
  if (!response.ok) throw new Error("Gateway configuration unavailable");
  const startup = (await response.json()) as { path: string; kernel: string };
  const selected = new URL(location.href).searchParams.get("notebook");
  if (selected) startup.path = selected;
  const initial = await createContext(startup, !selected);
  const workspace = new WorkspaceTools(
    initial.tools.listTools(),
    (path) => createContext({ path, kernel: startup.kernel }),
    async (directory) => {
      const response = await fetch(
        `/api/v1/notebooks?directory=${encodeURIComponent(directory)}`,
      );
      if (!response.ok) throw new Error("Folder unavailable");
      return response.json();
    },
  );
  await workspace.seed(startup.path, initial);
  installExplorer(
    startup.path,
    () => {},
    async (path) => {
      const result = await workspace.callTool("open_notebook", {
        notebook_path: path,
      });
      if (result.isError) throw new Error("Unable to open notebook");
    },
  );
  const webmcp = await installWebMcp(workspace);
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
      workspace.dispose();
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
