import { compileString } from "assemblyscript/asc";

/** No user filesystem callbacks, compiler flags, package imports or transforms. */
export async function compileGraphics(source: string): Promise<Uint8Array> {
  if (!source.trim() || new TextEncoder().encode(source).length > 64000)
    throw new Error("Graphics source must contain 1–64000 UTF-8 bytes");
  const result = await compileString(source, {
    runtime: "stub",
    importMemory: true,
    initialMemory: 256,
    maximumMemory: 256,
    optimizeLevel: 1,
    shrinkLevel: 0,
    noColors: true,
  });
  if (result.error || !result.binary) {
    // Diagnostics stay local and are never logged or returned as notebook output.
    throw new Error(
      `Graphics compilation failed: ${result.stderr.toString().slice(0, 400)}`,
    );
  }
  if (result.binary.length > 2_000_000)
    throw new Error("Graphics module exceeds 2 MB");
  return result.binary;
}
