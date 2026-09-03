/** Ephemeral presentation state, independent of notebook command/revision state. */
export interface MicroscopeTarget {
  cell_id: string;
  microscope_id: string;
  revision?: number;
  focus?: { step_index: number; annotation_id?: string | null } | null;
}
export interface FollowView {
  microscope?: MicroscopeTarget | null;
  protocol_version: 1;
  notebook_path: string;
  scroll_fraction: number;
  selected_cell_id?: string | null;
  driver_id: string;
}
export interface FollowTransport {
  subscribe(receive: (view: FollowView | null) => void): () => void;
}
export type FollowPosition = Pick<
  FollowView,
  | "protocol_version"
  | "notebook_path"
  | "scroll_fraction"
  | "selected_cell_id"
  | "microscope"
>;
export interface FollowPublisher {
  publish(view: FollowPosition): Promise<void>;
}
export function validateFollowView(value: unknown): FollowView {
  const view = value as FollowView;
  const target = view?.microscope;
  if (
    target &&
    ((target.revision !== undefined &&
      (!Number.isSafeInteger(target.revision) || target.revision < 0)) ||
      (target.focus != null &&
        (!Number.isInteger(target.focus.step_index) ||
          target.focus.step_index < 0 ||
          target.focus.step_index > 63 ||
          (target.focus.annotation_id != null &&
            (typeof target.focus.annotation_id !== "string" ||
              !/^[a-zA-Z0-9_-]{1,64}$/.test(target.focus.annotation_id))))))
  )
    throw new Error("Invalid walkthrough follow focus");
  if (
    view?.microscope != null &&
    (typeof view.microscope.cell_id !== "string" ||
      !view.microscope.cell_id ||
      view.microscope.cell_id.length > 128 ||
      typeof view.microscope.microscope_id !== "string" ||
      !/^[a-z0-9]{7}$/.test(view.microscope.microscope_id))
  )
    throw new Error("Invalid microscope follow target");
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
    view.scroll_fraction > 1 ||
    (view.selected_cell_id != null &&
      (typeof view.selected_cell_id !== "string" ||
        view.selected_cell_id.length < 1 ||
        view.selected_cell_id.length > 128))
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
