/** Owns isolated compiler/render workers for each bounded microscope region. */
export type GraphicsRequest = {
  key: string;
  region_id: string;
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

class RegionRuntime {
  private worker?: Worker;
  private ready = false;
  private busy = false;
  private failed = false;
  private frame = 0;
  private elapsed = 0;
  private last = 0;
  private dimensions = "";
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;

  constructor(
    private readonly host: GraphicsHost,
    private request: GraphicsRequest,
    private readonly compile: (source: string) => Promise<Uint8Array>,
  ) {
    this.start(request);
  }
  update(request: GraphicsRequest) {
    this.request = request;
  }
  private cleanup() {
    this.epoch++;
    clearTimeout(this.timer);
    if (this.worker) {
      const worker = this.worker;
      worker.onmessage = null;
      worker.onerror = null;
      worker.postMessage({ type: "dispose" });
      setTimeout(() => worker.terminate(), 50);
    }
    this.worker = undefined;
    this.ready = false;
    this.busy = false;
  }
  private fail(message: string) {
    if (this.failed) return;
    this.failed = true;
    const key = this.request.key;
    this.cleanup();
    this.host.graphicsError(key, message.slice(0, 512));
  }
  private deadline(ms: number, message: string) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(message), ms);
  }
  private async start(request: GraphicsRequest) {
    this.cleanup();
    this.request = request;
    this.failed = false;
    this.frame = 0;
    this.elapsed = 0;
    this.last = 0;
    this.dimensions = "";
    const key = request.key;
    const epoch = this.epoch;
    this.deadline(
      30000,
      "Graphics compilation timed out. Retry or simplify the source.",
    );
    try {
      const binary = await this.compile(request.source);
      if (this.request.key !== key || this.failed || epoch !== this.epoch)
        return;
      this.worker = new Worker(
        new URL("./graphics.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker.onerror = () =>
        this.fail("Graphics worker failed. Retry graphics.");
      this.worker.onmessage = ({ data }) => {
        if (this.request.key !== key || this.failed || epoch !== this.epoch)
          return;
        clearTimeout(this.timer);
        if (data.error) return this.fail(data.error);
        this.ready = true;
        this.busy = false;
        if (data.rgba) {
          try {
            this.host.graphicsFrame(key, data.width, data.height, data.rgba);
            this.frame++;
          } catch {
            this.fail("Invalid graphics frame. Update the graphics source.");
          }
        }
      };
      this.deadline(
        2000,
        "Graphics initialization timed out. Update the graphics source.",
      );
      this.worker.postMessage({ type: "init", ...request, binary }, [
        binary.buffer,
      ]);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }
  tick(now: number) {
    const request = this.request;
    if (!this.ready || this.busy || this.failed) return;
    const dimensions = `${request.width}:${request.height}`;
    if (
      (request.paused && this.frame > 0 && dimensions === this.dimensions) ||
      (this.last && now - this.last < 33)
    ) {
      if (request.paused) this.last = now;
      return;
    }
    const delta = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    if (!request.paused) this.elapsed += delta;
    this.dimensions = dimensions;
    this.busy = true;
    this.deadline(
      2000,
      "Graphics render timed out. Retry or simplify the source.",
    );
    this.worker!.postMessage({
      type: "render",
      width: request.width,
      height: request.height,
      elapsed: this.elapsed,
      delta: request.paused ? 0 : delta,
    });
  }
  dispose() {
    this.cleanup();
  }
}

export class GraphicsController {
  private readonly regions = new Map<string, RegionRuntime>();
  private animation = 0;
  private stopped = false;
  private compileQueue: Promise<void> = Promise.resolve();
  constructor(
    private readonly host: GraphicsHost,
    private readonly visible: () => boolean,
  ) {
    this.animation = requestAnimationFrame(this.tick);
  }
  private compile = (source: string): Promise<Uint8Array> => {
    let resolve!: (binary: Uint8Array) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<Uint8Array>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    this.compileQueue = this.compileQueue.then(
      () =>
        new Promise<void>((done) => {
          const compiler = new Worker(
            new URL("./graphics-compiler.worker.ts", import.meta.url),
            { type: "module" },
          );
          const timer = setTimeout(() => {
            compiler.terminate();
            reject(
              new Error(
                "Graphics compilation timed out. Retry or simplify the source.",
              ),
            );
            done();
          }, 30000);
          compiler.onerror = () => {
            clearTimeout(timer);
            compiler.terminate();
            reject(
              new Error("Graphics compiler could not load. Retry graphics."),
            );
            done();
          };
          compiler.onmessage = ({ data }) => {
            clearTimeout(timer);
            compiler.terminate();
            if (data.error) reject(new Error(data.error));
            else resolve(data.binary);
            done();
          };
          compiler.postMessage({ source });
        }),
    );
    return result;
  };
  private tick = (now: number) => {
    if (this.stopped) return;
    this.animation = requestAnimationFrame(this.tick);
    const requests: GraphicsRequest[] = this.visible()
      ? JSON.parse(this.host.graphicsRequest())
      : [];
    const active = new Set(requests.map((request) => request.key));
    for (const [key, runtime] of this.regions) {
      if (!active.has(key)) {
        runtime.dispose();
        this.regions.delete(key);
      }
    }
    for (const request of requests) {
      let runtime = this.regions.get(request.key);
      if (!runtime) {
        runtime = new RegionRuntime(this.host, request, this.compile);
        this.regions.set(request.key, runtime);
      } else runtime.update(request);
      runtime.tick(now);
    }
  };
  dispose() {
    this.stopped = true;
    cancelAnimationFrame(this.animation);
    for (const runtime of this.regions.values()) runtime.dispose();
    this.regions.clear();
    this.host.resetGraphics();
  }
}
