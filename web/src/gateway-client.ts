import type {
  CommandResult,
  NotebookCommand,
  NotebookTransport,
} from "./types";

export class GatewayNotebookTransport implements NotebookTransport {
  constructor(private readonly endpoint = "/api/v1/commands") {}
  private async call(command: NotebookCommand): Promise<CommandResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), command.timeout_ms);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
  setup = (c: NotebookCommand) => this.call(c);
  query = (c: NotebookCommand) => this.call(c);
  modifyCells = (c: NotebookCommand) => this.call(c);
  execute = (c: NotebookCommand) => this.call(c);
  interrupt = (c: NotebookCommand) => this.call(c);
  restart = (c: NotebookCommand) => this.call(c);
  reconnect = (c: NotebookCommand) => this.call(c);
  complete = (c: NotebookCommand) => this.call(c);
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
  override execute = this.setup;
  override interrupt = this.setup;
  override restart = this.setup;
  override reconnect = this.setup;
  override complete = this.setup;
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
