self.onmessage = async ({ data }: MessageEvent<{ source: string }>) => {
  try {
    // Register before importing the compiler: its top-level async initialization
    // otherwise allows the first worker message to arrive without a listener.
    const { compileGraphics } = await import("./graphics-compiler");
    const binary = await compileGraphics(data.source);
    self.postMessage({ binary }, { transfer: [binary.buffer as ArrayBuffer] });
  } catch (error) {
    self.postMessage({ error: String(error).slice(0, 512) });
  }
};
