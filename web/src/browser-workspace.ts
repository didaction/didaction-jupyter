import { NotebookApplication } from "../pkg/notebook_wasm";
import type { CollaborationState } from "./collaboration";
import { IndexedNotebookStore } from "./browser-store";
import { BrowserNotebookTransport } from "./browser-transport";
import { WorkerKernel } from "./browser-kernel";
import { BrowserArtifactTransport } from "./browser-artifacts";
import {
  DEFAULT_BROWSER_KERNEL,
  type BrowserKernelName,
} from "./browser-kernel-profile";

/** Explicit single-user policy, not a simulated collaboration server. */
export class LocalNotebookConnection {
  state: CollaborationState;
  constructor(path: string) {
    this.state = {
      notebook_path: path,
      client_id: "browser-local",
      driver_id: "browser-local",
      is_driver: true,
      clients: ["browser-local"],
      sequence: 0,
      origin: null,
      snapshot: null,
    };
  }
  join = async () => {};
  close = async () => {};
  publish = async () => {};
  headers = () => ({});
  rename = (path: string) => {
    this.state.notebook_path = path;
  };
  watch = async (
    receive: (state: CollaborationState) => void,
    _failure: () => void,
  ) => {
    receive(this.state);
  };
  subscribe = () => () => {};
  changeDriver = async () => {
    throw new Error(
      "Browser mode is single-user; driver handoff requires server mode",
    );
  };
  setDriverPermission = async (_action: "claim" | "release") => {
    throw new Error("Browser mode is local-only");
  };
}

export const NOTEBOOK_HEARTBEAT_MS = 30_000;
const NOTEBOOK_LIVENESS_TTL_MS = NOTEBOOK_HEARTBEAT_MS * 3;
const LEASE_STORAGE_PREFIX = "didaction-browser-notebook-lease:";

export interface NotebookLeaseState {
  schema_version: 1;
  workspace: string;
  path: string;
  owner_id: string;
  heartbeat_at: string;
}

export interface NotebookLease {
  readonly state: NotebookLeaseState;
  release(): void;
}

export class NotebookLockedError extends Error {
  constructor(
    readonly path: string,
    readonly liveness: NotebookLeaseState | null,
  ) {
    super(`Notebook ${path} is open in another tab.`);
    this.name = "NotebookLockedError";
  }
}

export class BrowserWorkspace {
  kernelName: BrowserKernelName = DEFAULT_BROWSER_KERNEL;
  readonly store = new IndexedNotebookStore();
  readonly artifacts = new BrowserArtifactTransport(this.store);
  private workspaceId =
    new URL(location.href).searchParams.get("workspace") ?? "legacy";
  private readonly ownerId =
    sessionStorage.getItem("didaction-browser-tab-id") ??
    crypto.randomUUID().slice(0, 8);
  private readonly leases = new Map<string, NotebookLease>();

  constructor() {
    sessionStorage.setItem("didaction-browser-tab-id", this.ownerId);
  }

  async selectWorkspace(id: string): Promise<void> {
    await this.store.selectWorkspace(id);
    this.workspaceId = id;
  }

  private leaseKey(path: string): string {
    return `${this.workspaceId}:${path}`;
  }

  private storageKey(path: string): string {
    return `${LEASE_STORAGE_PREFIX}${encodeURIComponent(this.leaseKey(path))}`;
  }

  private readLiveness(path: string): NotebookLeaseState | null {
    try {
      const value = localStorage.getItem(this.storageKey(path));
      if (!value) return null;
      const state = JSON.parse(value) as NotebookLeaseState;
      const age = Date.now() - Date.parse(state.heartbeat_at);
      return state.schema_version === 1 &&
        state.workspace === this.workspaceId &&
        state.path === path &&
        Number.isFinite(age) &&
        age <= NOTEBOOK_LIVENESS_TTL_MS
        ? state
        : null;
    } catch {
      return null;
    }
  }

  async acquire(path: string): Promise<NotebookLease> {
    if (!navigator.locks)
      throw new Error("Browser notebooks require Web Locks support");
    const existing = this.leases.get(this.leaseKey(path));
    if (existing) return existing;
    const observed = this.readLiveness(path);
    return new Promise<NotebookLease>((resolve, reject) => {
      void navigator.locks
        .request(
          `didaction-browser-notebook:${this.leaseKey(path)}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(
                new NotebookLockedError(
                  path,
                  this.readLiveness(path) ?? observed,
                ),
              );
              return;
            }
            await new Promise<void>((unlock) => {
              const state: NotebookLeaseState = {
                schema_version: 1,
                workspace: this.workspaceId,
                path,
                owner_id: this.ownerId,
                heartbeat_at: new Date().toISOString(),
              };
              const announce = () => {
                state.heartbeat_at = new Date().toISOString();
                localStorage.setItem(
                  this.storageKey(path),
                  JSON.stringify(state),
                );
                window.dispatchEvent(
                  new CustomEvent("browser-notebook-liveness", {
                    detail: { ...state },
                  }),
                );
              };
              announce();
              const timer = window.setInterval(announce, NOTEBOOK_HEARTBEAT_MS);
              let released = false;
              const lease: NotebookLease = {
                state,
                release: () => {
                  if (released) return;
                  released = true;
                  window.clearInterval(timer);
                  const current = this.readLiveness(path);
                  if (current?.owner_id === this.ownerId)
                    localStorage.removeItem(this.storageKey(path));
                  this.leases.delete(this.leaseKey(path));
                  unlock();
                },
              };
              this.leases.set(this.leaseKey(path), lease);
              resolve(lease);
            });
          },
        )
        .catch(reject);
    });
  }
  transport(path: string): BrowserNotebookTransport {
    return new BrowserNotebookTransport(
      path,
      this.store,
      new WorkerKernel(
        async () => ({
          files: await this.store.artifacts(),
          directory: path.split("/").slice(0, -1).join("/"),
        }),
        this.kernelName,
      ),
      (snapshot) => new NotebookApplication(snapshot),
      this.kernelName,
    );
  }
  close(): void {
    for (const lease of [...this.leases.values()]) lease.release();
  }
}
