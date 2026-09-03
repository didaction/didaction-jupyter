export type GraphicsFrame = {
  width: number;
  height: number;
  elapsed: number;
  delta: number;
};
export function validateFrame(f: GraphicsFrame) {
  if (
    !Number.isInteger(f.width) ||
    !Number.isInteger(f.height) ||
    f.width < 1 ||
    f.height < 1 ||
    f.width > 1024 ||
    f.height > 768 ||
    !Number.isFinite(f.elapsed) ||
    !Number.isFinite(f.delta) ||
    f.elapsed < 0 ||
    f.delta < 0
  )
    throw new Error("Invalid graphics dimensions or clock");
}
/** Guest has only capped linear memory and a trapping abort: no JS capabilities. */
export async function instantiateGraphics(
  binary: Uint8Array,
  width: number,
  height: number,
  index: number,
) {
  if (binary.length > 2_000_000)
    throw new Error("Graphics module exceeds bounds");
  const module = await WebAssembly.compile(binary as Uint8Array<ArrayBuffer>);
  for (const i of WebAssembly.Module.imports(module)) {
    if (
      i.module !== "env" ||
      !(
        (i.name === "memory" && i.kind === "memory") ||
        (i.name === "abort" && i.kind === "function")
      )
    )
      throw new Error("Graphics imports are restricted to memory and abort");
  }
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 256 });
  const instance = await WebAssembly.instantiate(module, {
    env: {
      memory,
      abort: () => {
        throw new Error("Graphics aborted");
      },
    },
  });
  const { init, render, dispose } = instance.exports;
  if (
    typeof init !== "function" ||
    typeof render !== "function" ||
    typeof dispose !== "function"
  )
    throw new Error("Graphics must export init, render and dispose");
  validateFrame({ width, height, elapsed: 0, delta: 0 });
  init(width, height, index);
  return {
    render(f: GraphicsFrame) {
      validateFrame(f);
      const pointer = render(f.width, f.height, f.elapsed, f.delta);
      const bytes = f.width * f.height * 4;
      if (
        !Number.isInteger(pointer) ||
        pointer < 0 ||
        pointer + bytes > memory.buffer.byteLength
      )
        throw new Error("Graphics returned an invalid RGBA buffer");
      return new Uint8Array(memory.buffer, pointer, bytes).slice();
    },
    dispose: () => {
      dispose();
    },
  };
}
