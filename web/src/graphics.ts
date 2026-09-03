/** Owns compiler/execution workers and backpressure, not notebook authority. */
export type GraphicsRequest = {
  key: string;
  source: string;
  width: number;
  height: number;
  step_index: number;
  paused: boolean;
};
export interface GraphicsHost {
  resetGraphics(): void;
  graphicsRequest(): string;
  graphicsFrame(
    key: string,
    width: number,
    height: number,
    rgba: Uint8Array,
  ): void;
  graphicsError(key: string, error: string): void;
}
export class GraphicsController {
  private compiler?: Worker;
  private worker?: Worker;
  private key = "";
  private failed = false;
  private ready = false;
  private busy = false;
  private frame = 0;
  private elapsed = 0;
  private last = 0;
  private dimensions = "";
  private timer?: ReturnType<typeof setTimeout>;
  private animation = 0;
  private stopped = false;
  private epoch = 0;
  constructor(
    private readonly host: GraphicsHost,
    private readonly visible: () => boolean,
  ) {
    this.animation = requestAnimationFrame(this.tick);
  }
  private cleanup() {
    this.epoch++;
    clearTimeout(this.timer);
    if (this.compiler) {
      this.compiler.onmessage = null;
      this.compiler.onerror = null;
      this.compiler.terminate();
    }
    this.compiler = undefined;
    if (this.worker) {
      const old = this.worker;
      old.onmessage = null;
      old.onerror = null;
      old.postMessage({ type: "dispose" });
      setTimeout(() => old.terminate(), 50); // dispose is best-effort, including if hung.
      this.worker = undefined;
    }
    this.ready = false;
    this.busy = false;
    this.frame = 0;
    this.last = 0;
    this.elapsed = 0;
    this.dimensions = "";
  }
  private fail(key: string, message: string) {
    if (this.stopped || this.key !== key) return;
    this.failed = true;
    this.cleanup();
    this.host.graphicsError(key, message.slice(0, 512));
  }
  private deadline(key: string, ms: number, message: string) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(key, message), ms);
  }
  private start(r: GraphicsRequest) {
    const key = r.key;
    this.cleanup();
    this.key = key;
    this.failed = false;
    const epoch = this.epoch;
    this.compiler = new Worker(
      new URL("./graphics-compiler.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.deadline(
      key,
      30000,
      "Graphics compilation timed out. Retry or simplify the source.",
    );
    this.compiler.onerror = () =>
      this.fail(key, "Graphics compiler could not load. Retry graphics.");
    this.compiler.onmessage = ({ data }) => {
      if (
        this.key !== key ||
        this.stopped ||
        this.failed ||
        epoch !== this.epoch
      )
        return;
      this.compiler?.terminate();
      this.compiler = undefined;
      if (data.error) return this.fail(key, data.error);
      this.worker = new Worker(
        new URL("./graphics.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker.onerror = () =>
        this.fail(key, "Graphics worker failed. Retry graphics.");
      this.worker.onmessage = ({ data }) => {
        if (
          this.key !== key ||
          this.stopped ||
          this.failed ||
          epoch !== this.epoch
        )
          return;
        clearTimeout(this.timer);
        if (data.error) return this.fail(key, data.error);
        this.ready = true;
        this.busy = false;
        if (data.rgba) {
          try {
            this.host.graphicsFrame(key, data.width, data.height, data.rgba);
            this.frame++;
          } catch {
            this.fail(
              key,
              "Invalid graphics frame. Update the graphics source.",
            );
          }
        }
      };
      this.deadline(
        key,
        2000,
        "Graphics initialization timed out. Update the graphics source.",
      );
      this.worker.postMessage({ type: "init", ...r, binary: data.binary }, [
        data.binary.buffer,
      ]);
    };
    this.compiler.postMessage({ source: r.source });
  }
  private tick = (now: number) => {
    if (this.stopped) return;
    this.animation = requestAnimationFrame(this.tick);
    const r: GraphicsRequest | null = this.visible()
      ? JSON.parse(this.host.graphicsRequest())
      : null;
    if (!r) {
      if (this.key) {
        this.key = "";
        this.cleanup();
        this.host.resetGraphics();
      }
      return;
    }
    if (r.key !== this.key) {
      this.start(r);
      return;
    }
    if (!this.ready || this.busy || this.failed) return;
    const dims = `${r.width}:${r.height}`;
    if (
      (r.paused && this.frame > 0 && dims === this.dimensions) ||
      (this.last && now - this.last < 33)
    ) {
      if (r.paused) this.last = now;
      return;
    }
    const delta = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    if (!r.paused) this.elapsed += delta;
    this.dimensions = dims;
    this.busy = true;
    this.deadline(
      r.key,
      2000,
      "Graphics render timed out. Retry or simplify the source.",
    );
    this.worker!.postMessage({
      type: "render",
      width: r.width,
      height: r.height,
      elapsed: this.elapsed,
      delta: r.paused ? 0 : delta,
    });
  };
  dispose() {
    this.stopped = true;
    cancelAnimationFrame(this.animation);
    this.cleanup();
    this.host.resetGraphics();
  }
}
