import type { ToolResult } from "./notebook-tools";

export interface CallEntry {
  id: number;
  tool: string;
  started: string;
  status: "running" | "succeeded" | "failed";
  durationMs?: number;
}

/** Memory-only metadata; never retains arguments, results, errors or notebook paths. */
export class CallHistory {
  private entries: CallEntry[] = [];
  private nextId = 0;
  private capacity = 10;
  private listeners = new Set<() => void>();
  get limit() {
    return this.capacity;
  }
  snapshot() {
    return this.entries.map((entry) => ({ ...entry }));
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Diagnostics must never alter a notebook call. */
      }
    }
  }
  setLimit(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 100)
      throw new Error("Use a whole number from 1 to 100");
    this.capacity = value;
    this.entries = this.entries.slice(-value);
    this.changed();
  }
  clear() {
    this.entries = [];
    this.changed();
  }
  async record(
    tool: string,
    invoke: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const entry: CallEntry = {
      id: ++this.nextId,
      tool: tool.slice(0, 128),
      started: new Date().toISOString(),
      status: "running",
    };
    const start = performance.now();
    this.entries.push(entry);
    this.entries = this.entries.slice(-this.capacity);
    this.changed();
    try {
      const result = await invoke();
      entry.status = result.isError ? "failed" : "succeeded";
      return result;
    } catch (error) {
      entry.status = "failed";
      throw error;
    } finally {
      entry.durationMs = Math.max(0, Math.round(performance.now() - start));
      this.changed();
    }
  }
}

export function installDiagnostics(
  history: CallHistory,
  build: { git_sha: string; dirty: string },
) {
  const panel = document.querySelector<HTMLElement>("#diagnostics-panel")!;
  const toggle = document.querySelector<HTMLButtonElement>(
    "#diagnostics-toggle",
  )!;
  const close =
    document.querySelector<HTMLButtonElement>("#diagnostics-close")!;
  const limit = document.querySelector<HTMLInputElement>("#diagnostics-limit")!;
  const list = document.querySelector<HTMLOListElement>("#diagnostics-calls")!;
  const empty = document.querySelector<HTMLElement>("#diagnostics-empty")!;
  document.querySelector("#wasm-git-sha")!.textContent = build.git_sha;
  document.querySelector("#wasm-build-state")!.textContent =
    build.dirty === "true"
      ? "Built with uncommitted changes"
      : build.dirty === "false"
        ? "Clean source checkout"
        : "Source checkout state unavailable";
  const render = () => {
    const entries = history.snapshot().reverse();
    empty.hidden = entries.length > 0;
    list.replaceChildren(
      ...entries.map((entry) => {
        const li = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = entry.tool;
        const detail = document.createElement("span");
        detail.textContent = `${new Date(entry.started).toLocaleTimeString()} · ${entry.status}${entry.durationMs === undefined ? "" : ` · ${entry.durationMs} ms`}`;
        li.dataset.status = entry.status;
        li.append(name, detail);
        return li;
      }),
    );
  };
  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    document.body.classList.toggle("diagnostics-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) close.focus();
    else document.querySelector<HTMLElement>("#notebook-canvas")?.focus();
    window.dispatchEvent(new Event("resize"));
  };
  toggle.onclick = () => setOpen(panel.hidden);
  close.onclick = () => setOpen(false);
  panel.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    }
  };
  limit.onchange = () => {
    try {
      history.setLimit(limit.valueAsNumber);
      limit.setCustomValidity("");
    } catch {
      limit.setCustomValidity("Use a whole number from 1 to 100");
      limit.reportValidity();
    }
  };
  document.querySelector<HTMLButtonElement>("#diagnostics-clear")!.onclick =
    () => history.clear();
  const unsubscribe = history.subscribe(render);
  render();
  return { toggle: () => setOpen(panel.hidden), dispose: unsubscribe };
}
