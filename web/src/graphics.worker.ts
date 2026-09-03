import { instantiateGraphics, type GraphicsFrame } from "./graphics-module";
let module: Awaited<ReturnType<typeof instantiateGraphics>> | undefined;
self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (data.type === "init") {
      module = await instantiateGraphics(
        data.binary,
        data.width,
        data.height,
        data.step_index,
      );
      self.postMessage({ ready: true });
    } else if (data.type === "render" && module) {
      const frame = data as GraphicsFrame;
      const rgba = module.render(frame);
      self.postMessage(
        { width: frame.width, height: frame.height, rgba },
        { transfer: [rgba.buffer] },
      );
    } else if (data.type === "dispose") {
      module?.dispose();
      self.close();
    }
  } catch {
    // Guest exception messages must not become a data exfiltration channel.
    self.postMessage({
      error:
        "Graphics failed: invalid module, restricted import, memory limit or runtime trap. Retry or update the graphics source.",
    });
  }
};
