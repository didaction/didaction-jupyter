/** Ephemeral presentation state, independent of notebook command/revision state. */
export interface FollowView {
  protocol_version: 1;
  notebook_path: string;
  scroll_fraction: number;
  driver_id: string;
}
export interface FollowTransport {
  subscribe(receive: (view: FollowView | null) => void): () => void;
}
export type FollowPosition = Pick<
  FollowView,
  "protocol_version" | "notebook_path" | "scroll_fraction"
>;
export interface FollowPublisher {
  publish(view: FollowPosition): Promise<void>;
}
export function validateFollowView(value: unknown): FollowView {
  const view = value as FollowView;
  if (
    !view ||
    view.protocol_version !== 1 ||
    typeof view.notebook_path !== "string" ||
    view.notebook_path.length > 512 ||
    !view.notebook_path.endsWith(".ipynb") ||
    /[\\%?#:\x00-\x1f]/.test(view.notebook_path) ||
    view.notebook_path
      .split("/")
      .some((part) => !part || part.startsWith(".")) ||
    typeof view.driver_id !== "string" ||
    !view.driver_id ||
    view.driver_id.length > 128 ||
    !Number.isFinite(view.scroll_fraction) ||
    view.scroll_fraction < 0 ||
    view.scroll_fraction > 1
  )
    throw new Error("Invalid follow viewport");
  return view;
}

/** Opt-in, coalescing controller. A generation guard cancels pending navigation. */
export class FollowController {
  private unsubscribe?: () => void;
  private generation = 0;
  private epoch = 0;
  private latest?: FollowView;
  private applying = false;
  constructor(
    private apply: (view: FollowView, current: () => boolean) => Promise<void>,
    private clear: () => void,
    private unavailable: () => void,
  ) {}
  get enabled(): boolean {
    return this.unsubscribe !== undefined;
  }
  start(transport: FollowTransport): void {
    this.stop();
    const generation = this.generation;
    this.unsubscribe = transport.subscribe((value) => {
      if (generation !== this.generation) return;
      if (value === null) {
        this.epoch++;
        this.latest = undefined;
        this.clear();
        this.unavailable();
        return;
      }
      try {
        this.latest = validateFollowView(value);
      } catch {
        this.epoch++;
        this.latest = undefined;
        this.clear();
        this.unavailable();
        return;
      }
      void this.drain();
    });
  }
  stop(): void {
    this.generation++;
    this.epoch++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.latest = undefined;
    this.clear();
  }
  private async drain(): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    try {
      while (this.latest) {
        const view = this.latest;
        this.latest = undefined;
        const epoch = this.epoch;
        try {
          await this.apply(view, () => epoch === this.epoch);
        } catch {
          this.unavailable();
        }
      }
    } finally {
      this.applying = false;
    }
  }
}
