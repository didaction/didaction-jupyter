import { EmpackedXeusRemoteKernel } from "@jupyterlite/xeus/lib/worker";
import { mountWorkspace } from "./browser-workspace-mount";

/** Official xeus Jupyter protocol, behind the same bounded worker interface. */
class Kernel extends EmpackedXeusRemoteKernel {
  private mounted = new Set<string>();
  protected initializeLogger(
    options: Parameters<EmpackedXeusRemoteKernel["initialize"]>[0],
  ) {
    const logger = super.initializeLogger(options);
    // Keep upstream diagnostic broadcasts from leaking cell contents or outputs.
    logger.log = logger.warn = logger.error = () => {};
    return logger;
  }
  protected initializeStdin(): void {
    Object.assign(globalThis, {
      get_stdin: () => ({ error: "Interactive stdin is unsupported" }),
    });
  }
  async mount(): Promise<void> {
    /* No JupyterLite drive or service worker. */
  }
  mountWorkspace(workspace: Parameters<typeof mountWorkspace>[2]) {
    mountWorkspace(this.Module.FS, this.mounted, workspace);
  }
  protected async processMagics(code: string): Promise<string> {
    // Do not expose upstream's dynamic conda/pip installer or shell forwarding.
    if (
      /^\s*(?:!|%(?:pip|mamba|conda|micromamba|rattler)\b|%%(?:bash|sh)\b)/m.test(
        code,
      )
    )
      throw new Error("Package and shell commands are unsupported");
    return code;
  }
}
const kernel = new Kernel();
const send = self.postMessage.bind(self);
let active:
  | {
      id: string;
      reply?: Record<string, unknown>;
      idle: boolean;
      resolve(): void;
    }
  | undefined;
// xeus-lite emits full Jupyter envelopes through global postMessage.
Object.assign(globalThis, {
  postMessage: (msg: {
    header?: { msg_type: string };
    parent_header?: { msg_id?: string };
    channel?: string;
    content?: Record<string, unknown>;
  }) => {
    if (
      !active ||
      msg.parent_header?.msg_id !== active.id ||
      !msg.header ||
      !msg.content
    )
      return;
    const type = msg.header.msg_type;
    if (
      new TextEncoder().encode(JSON.stringify(msg.content)).byteLength >
      1_000_000
    ) {
      send({ id: active.id, error: "Kernel output exceeds message limit" });
      active.resolve();
      active = undefined;
      return;
    }
    if (msg.channel === "iopub") {
      if (
        [
          "stream",
          "display_data",
          "update_display_data",
          "execute_result",
          "error",
          "clear_output",
        ].includes(type)
      )
        send({ id: active.id, event: { type, bundle: msg.content } });
      if (type === "status" && msg.content.execution_state === "idle")
        active.idle = true;
    } else if (msg.channel === "shell" && type.endsWith("_reply")) {
      active.reply = msg.content;
      if (type !== "execute_reply") active.idle = true;
    }
    if (active.reply && active.idle) {
      send({ id: active.id, result: active.reply });
      active.resolve();
      active = undefined;
    }
  },
});
let tail = Promise.resolve();
self.onmessage = ({ data }) => {
  tail = tail.then(async () => {
    const { id, method, code, cursor, workspace } = data;
    try {
      if (method === "initialize") {
        const baseUrl = new URL(import.meta.env.BASE_URL, self.location.origin)
          .href;
        const root = `${baseUrl}xeus/didaction-xeus`;
        const response = await fetch(`${root}/xpython/kernel.json`);
        if (!response.ok) throw new Error("Missing xeus assets");
        const spec = await response.json();
        const options = {
          baseUrl,
          kernelId: id,
          kernelSpec: {
            ...spec,
            name: "xpython",
            dir: "xpython",
            envName: "didaction-xeus",
          },
          mountDrive: false,
          browsingContextId: id,
          empackEnvMetaLink: root,
        };
        await kernel.initialize(options);
        send({ id, result: {} });
      } else if (method === "workspace") {
        kernel.mountWorkspace(workspace);
        send({ id, result: {} });
      } else {
        if (!["execute", "complete", "inspect"].includes(method))
          throw new Error("Unsupported operation");
        const content =
          method === "execute"
            ? {
                code,
                silent: false,
                store_history: true,
                user_expressions: {},
                allow_stdin: false,
                stop_on_error: true,
              }
            : { code, cursor_pos: cursor, detail_level: 0 };
        const done = new Promise<void>((resolve) => {
          active = { id, idle: false, resolve };
        });
        await kernel.processMessage({
          msg: {
            header: {
              msg_id: id,
              msg_type: `${method}_request`,
              session: "didaction",
              username: "browser",
              version: "5.3",
              date: new Date().toISOString(),
            },
            parent_header: {},
            metadata: {},
            content,
            channel: "shell",
            buffers: [],
          },
        });
        await done;
      }
    } catch {
      if (active && active.id === id) {
        active.resolve();
        active = undefined;
      }
      send({
        id,
        error:
          "Xeus kernel operation failed; restart and retry. Check that the xeus assets were prepared.",
      });
    }
  });
};
