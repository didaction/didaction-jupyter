export type NotebookCommand = Record<string, unknown> & {
  protocol_version: 1;
  command_id: string;
  idempotency_key: string;
  timeout_ms: number;
  type: string;
};
export type CommandResult = Record<string, unknown> & {
  protocol_version: 1;
  command_id: string;
  idempotency_key: string;
  snapshot?: NotebookSnapshot;
  completion?: {
    matches: string[];
    cursor_start: number;
    cursor_end: number;
  };
  inspection?: { found: boolean; text: string };
  error?: { code: string; message: string; retryable: boolean };
};
export type NotebookSnapshot = Record<string, unknown> & {
  protocol_version: 1;
  revision: number;
  cells: unknown[];
};
export type NotebookProgress = (result: CommandResult) => void;
export interface WasmApplication {
  prepareCommand(input: string): string;
  applyCommandResult(input: string): string;
  publicSnapshot(): string;
  dispose(): void;
}
export interface NotebookTransport {
  setup(command: NotebookCommand): Promise<CommandResult>;
  query(command: NotebookCommand): Promise<CommandResult>;
  modifyCells(command: NotebookCommand): Promise<CommandResult>;
  execute(
    command: NotebookCommand,
    onProgress?: NotebookProgress,
  ): Promise<CommandResult>;
  interrupt(command: NotebookCommand): Promise<CommandResult>;
  restart(command: NotebookCommand): Promise<CommandResult>;
  checkpoint(command: NotebookCommand): Promise<CommandResult>;
  rename(command: NotebookCommand): Promise<CommandResult>;
  download(command: NotebookCommand): Promise<CommandResult>;
  reconnect(command: NotebookCommand): Promise<CommandResult>;
  complete(command: NotebookCommand): Promise<CommandResult>;
  inspect(command: NotebookCommand): Promise<CommandResult>;
  close(): Promise<void>;
}
