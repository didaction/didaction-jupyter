import type {
  CommandResult,
  NotebookCommand,
  NotebookProgress,
  NotebookTransport,
  WasmApplication,
} from "./types";

export class CommandGateway {
  constructor(
    private readonly wasm: WasmApplication,
    private readonly transport: NotebookTransport,
  ) {}
  async execute(
    serialized: string,
    onProgress?: NotebookProgress,
  ): Promise<string> {
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
      create_checkpoint: "checkpoint",
      rename_notebook: "rename",
      download_notebook: "download",
      reconnect: "reconnect",
      complete: "complete",
      inspect: "inspect",
    };
    const method = route[command.type];
    if (!method || method === "close")
      throw new Error("Unsupported notebook command");
    const result = await (
      this.transport[method] as (
        c: NotebookCommand,
        progress?: NotebookProgress,
      ) => Promise<CommandResult>
    )(command, onProgress);
    this.wasm.applyCommandResult(JSON.stringify(result));
    return JSON.stringify(result);
  }
}

export function createQueuedNotebookDispatcher(
  gateway: CommandGateway,
  currentRevision: () => number,
): (
  serialized: string,
  onProgress?: (serialized: string) => void,
) => Promise<string> {
  let tail = Promise.resolve();
  return (serialized: string, onProgress?: (serialized: string) => void) => {
    const task = tail.then(() => {
      const command = JSON.parse(serialized) as NotebookCommand;
      command.expected_revision = currentRevision();
      return gateway.execute(
        JSON.stringify(command),
        onProgress ? (result) => onProgress(JSON.stringify(result)) : undefined,
      );
    });
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}
