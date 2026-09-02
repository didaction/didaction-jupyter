import type {
  CommandResult,
  NotebookCommand,
  NotebookProgress,
  NotebookTransport,
} from "./types";

export class GatewayNotebookTransport implements NotebookTransport {
  constructor(
    private readonly endpoint = "/api/v1/commands",
    private notebookPath?: string,
  ) {}
  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.notebookPath
        ? { "x-notebook-path": encodeURIComponent(this.notebookPath) }
        : {}),
    };
  }
  private async call(command: NotebookCommand): Promise<CommandResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), command.timeout_ms);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(command),
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error(`Gateway returned HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 4_000_000)
        throw new Error("Gateway response exceeded the browser limit");
      return JSON.parse(text) as CommandResult;
    } finally {
      clearTimeout(timer);
    }
  }
  private async callStream(
    command: NotebookCommand,
    onProgress?: NotebookProgress,
  ): Promise<CommandResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), command.timeout_ms);
    try {
      const response = await fetch(`${this.endpoint}/stream`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(command),
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!response.ok || !response.body)
        throw new Error(`Gateway stream returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let latest: CommandResult | undefined;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        if (buffered.length > 4_000_000 && !buffered.includes("\n"))
          throw new Error("Gateway stream event exceeded the browser limit");
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          latest = JSON.parse(line) as CommandResult;
          onProgress?.(latest);
        }
      }
      if (buffered.trim()) {
        latest = JSON.parse(buffered) as CommandResult;
        onProgress?.(latest);
      }
      if (!latest) throw new Error("Gateway stream returned no result");
      return latest;
    } finally {
      clearTimeout(timer);
    }
  }
  setup = (c: NotebookCommand) => this.call(c);
  query = (c: NotebookCommand) => this.call(c);
  modifyCells = (c: NotebookCommand) => this.call(c);
  execute = (c: NotebookCommand, onProgress?: NotebookProgress) =>
    this.callStream(c, onProgress);
  interrupt = (c: NotebookCommand) => this.call(c);
  restart = (c: NotebookCommand) => this.call(c);
  checkpoint = (c: NotebookCommand) => this.call(c);
  rename = async (c: NotebookCommand) => {
    const result = await this.call(c);
    const notebook = result.snapshot?.notebook as
      | { path?: unknown }
      | undefined;
    if (!result.error && typeof notebook?.path === "string") {
      this.notebookPath = notebook.path;
      const url = new URL(location.href);
      url.searchParams.set("notebook", this.notebookPath);
      history.replaceState(null, "", url);
    }
    return result;
  };
  download = async (command: NotebookCommand): Promise<CommandResult> => {
    const result = await this.call({
      ...command,
      type: "query",
      query: "full",
    });
    if (result.error) return result;
    const response = await fetch("/api/v1/download", {
      headers: this.headers(),
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Notebook download failed");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "notebook.ipynb";
    anchor.click();
    URL.revokeObjectURL(url);
    return result;
  };
  reconnect = (c: NotebookCommand) => this.call(c);
  complete = (c: NotebookCommand) => this.call(c);
  inspect = (c: NotebookCommand) => this.call(c);
  close = async () => {};
}

export class MockNotebookTransport extends GatewayNotebookTransport {
  constructor(
    private readonly handler: (
      command: NotebookCommand,
    ) => CommandResult | Promise<CommandResult>,
  ) {
    super("mock:");
  }
  override setup = (c: NotebookCommand) => Promise.resolve(this.handler(c));
  override query = this.setup;
  override modifyCells = this.setup;
  override execute = (c: NotebookCommand, _onProgress?: NotebookProgress) =>
    Promise.resolve(this.handler(c));
  override interrupt = this.setup;
  override restart = this.setup;
  override checkpoint = this.setup;
  override rename = this.setup;
  override download = this.setup;
  override reconnect = this.setup;
  override complete = this.setup;
  override inspect = this.setup;
}

export type Fault =
  | "timeout"
  | "malformed"
  | "disconnect"
  | "duplicate"
  | "delayed"
  | "stale";
export class FaultInjectionTransport extends MockNotebookTransport {
  constructor(fault: Fault, result: CommandResult) {
    let duplicate: CommandResult | undefined;
    super(async (command) => {
      if (fault === "timeout") return new Promise<CommandResult>(() => {});
      if (fault === "disconnect") throw new Error("disconnected");
      if (fault === "malformed")
        return { nonsense: true } as unknown as CommandResult;
      if (fault === "delayed")
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (fault === "stale")
        return { ...result, command_id: command.command_id, base_revision: 0 };
      if (fault === "duplicate" && duplicate) return duplicate;
      duplicate = { ...result, command_id: command.command_id };
      return duplicate;
    });
  }
}
