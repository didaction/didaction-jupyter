import type { NotebookSnapshot } from "./types";

export interface CollaborationState {
  notebook_path: string;
  client_id: string;
  driver_id: string | null;
  is_driver: boolean;
  clients: string[];
  sequence: number;
  origin: string | null;
  snapshot: NotebookSnapshot | null;
}

/** HTTP adapter; ownership policy and fanout live in the gateway, not here. */
export class NotebookCollaboration {
  private token = "";
  private stopped = false;
  private controller = new AbortController();
  state?: CollaborationState;
  constructor(private path: string) {}
  rename(path: string): void {
    this.path = path;
  }
  headers(): Record<string, string> {
    return {
      "x-notebook-path": encodeURIComponent(this.path),
      "x-notebook-client": this.token,
    };
  }
  async join(): Promise<void> {
    const response = await fetch("/api/v1/collaboration/join", {
      method: "POST",
      headers: this.headers(),
      signal: this.controller.signal,
    });
    if (!response.ok) throw new Error("Unable to join notebook collaboration");
    const { token, ...state } =
      (await response.json()) as CollaborationState & { token: string };
    this.token = token;
    this.state = state;
  }
  async changeDriver(clientId: string): Promise<void> {
    const response = await fetch(
      `/api/v1/collaboration/driver/${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: this.headers(),
      },
    );
    if (!response.ok)
      throw new Error(
        "Driver handoff refused; wait until idle and select a connected collaborator",
      );
  }
  async watch(
    onState: (state: CollaborationState) => void,
    onDisconnect: () => void,
  ): Promise<void> {
    let sequence = -1;
    while (!this.stopped) {
      try {
        const response = await fetch(
          `/api/v1/collaboration/events?after=${sequence}`,
          {
            headers: this.headers(),
            signal: AbortSignal.any([
              this.controller.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        );
        if (response.status === 403) {
          onDisconnect();
          await this.join();
          sequence = -1;
          continue;
        }
        if (!response.ok) throw new Error("Collaboration disconnected");
        const text = await response.text();
        if (text.length > 4_000_000)
          throw new Error("Collaboration snapshot exceeds limit");
        const state = JSON.parse(text) as CollaborationState;
        if (state.notebook_path) this.path = state.notebook_path;
        onState(state);
        this.state = state;
        sequence = state.sequence;
      } catch {
        if (this.stopped) return;
        onDisconnect();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    await fetch("/api/v1/collaboration/leave", {
      method: "POST",
      headers: this.headers(),
      keepalive: true,
    }).catch(() => undefined);
  }
}
