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
  error?: { code: string; message: string; retryable: boolean };
};
export type NotebookSnapshot = Record<string, unknown> & {
  protocol_version: 1;
  revision: number;
  cells: unknown[];
};
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
  execute(command: NotebookCommand): Promise<CommandResult>;
  interrupt(command: NotebookCommand): Promise<CommandResult>;
  restart(command: NotebookCommand): Promise<CommandResult>;
  reconnect(command: NotebookCommand): Promise<CommandResult>;
  close(): Promise<void>;
}
