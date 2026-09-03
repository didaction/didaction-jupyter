import type {
  CommandResult,
  NotebookCommand,
  NotebookProgress,
  NotebookTransport,
  WasmApplication,
} from "./types";
import type { Execute, Transaction } from "./notebook-tools";

export class CommandGateway {
  constructor(
    private readonly wasm: WasmApplication,
    private readonly transport: NotebookTransport,
  ) {}
  async execute(
    serialized: string,
    onProgress?: NotebookProgress,
  ): Promise<string> {
    const before = this.wasm.publicSnapshot();
    try {
      const validated = this.wasm.prepareCommand(serialized);
      const command = JSON.parse(validated) as NotebookCommand;
      const route: Record<string, keyof NotebookTransport> = {
        setup: "setup",
        query: "query",
        modify_cells: "modifyCells",
        create_microscope: "modifyCells",
        set_microscope_walkthrough: "modifyCells",
        delete_microscope: "modifyCells",
        read_microscope: "query",
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
      if (result.error && this.wasm.replaceSnapshot) {
        this.wasm.replaceSnapshot(JSON.stringify(JSON.parse(before).snapshot));
      }
      return JSON.stringify(result);
    } catch (error) {
      if (this.wasm.replaceSnapshot)
        this.wasm.replaceSnapshot(JSON.stringify(JSON.parse(before).snapshot));
      throw error;
    }
  }
}

export function createQueuedNotebookDispatcher(
  gateway: CommandGateway,
  currentRevision: () => number,
  committed?: (command: NotebookCommand, result: CommandResult) => void,
): ((
  serialized: string,
  onProgress?: (serialized: string) => void,
) => Promise<string>) & { transaction: Transaction } {
  let tail = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const task = tail.then(work);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  const execute = async (
    serialized: string,
    onProgress?: (serialized: string) => void,
  ) => {
    const command = JSON.parse(serialized) as NotebookCommand;
    // Absolute positions cannot be silently rebased: a reorder changes intent.
    const positional =
      command.type === "modify_cells" &&
      Array.isArray(command.changes) &&
      command.changes.some(
        (change) =>
          change.operation === "insert" || change.operation === "move",
      );
    if (positional && command.expected_revision == null)
      throw new Error("Absolute cell positions require expected_revision");
    if (!positional) command.expected_revision = currentRevision();
    const serializedResult = await gateway.execute(
      JSON.stringify(command),
      onProgress ? (result) => onProgress(JSON.stringify(result)) : undefined,
    );
    const result = JSON.parse(serializedResult) as CommandResult;
    if (!result.error) committed?.(command, result);
    return serializedResult;
  };
  return Object.assign(
    (serialized: string, onProgress?: (serialized: string) => void) =>
      enqueue(() => execute(serialized, onProgress)),
    {
      transaction: <T>(task: (execute: Execute) => Promise<T>) =>
        enqueue(() => task(execute)),
    },
  );
}
