import type {
  CommandResult,
  NotebookCommand,
  NotebookTransport,
  WasmApplication,
} from "./types";

export class CommandGateway {
  constructor(
    private readonly wasm: WasmApplication,
    private readonly transport: NotebookTransport,
  ) {}
  async execute(serialized: string): Promise<string> {
    const validated = this.wasm.prepareCommand(serialized);
    const command = JSON.parse(validated) as NotebookCommand;
    const route: Record<string, keyof NotebookTransport> = {
      setup: "setup",
      query: "query",
      modify_cells: "modifyCells",
      execute_cell: "execute",
      execute_code: "execute",
      interrupt_kernel: "interrupt",
      restart_kernel: "restart",
      reconnect: "reconnect",
    };
    const method = route[command.type];
    if (!method || method === "close")
      throw new Error("Unsupported notebook command");
    const result = await (
      this.transport[method] as (c: NotebookCommand) => Promise<CommandResult>
    )(command);
    this.wasm.applyCommandResult(JSON.stringify(result));
    return JSON.stringify(result);
  }
}
