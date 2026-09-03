import { describe, expect, it } from "vitest";
import { compileGraphics } from "./graphics-compiler";
import { instantiateGraphics, validateFrame } from "./graphics-module";

const source = `
const pixels = new StaticArray<u8>(1024 * 768 * 4);
export function init(w:i32, h:i32, step:i32):void {}
export function render(w:i32, h:i32, time:f64, delta:f64):usize {
  pixels[0] = <u8>(time * 10); pixels[3] = 255;
  return changetype<usize>(pixels);
}
export function dispose():void {}
`;
describe("AssemblyScript RGBA graphics", () => {
  it("compiles real source, initializes fresh state and returns bounded animated frames", async () => {
    const binary = await compileGraphics(source);
    const module = await instantiateGraphics(binary, 8, 8, 0);
    expect(
      module.render({ width: 8, height: 8, elapsed: 2, delta: 1 })[0],
    ).toBe(20);
    expect(
      module.render({ width: 4, height: 2, elapsed: 3, delta: 1 }),
    ).toHaveLength(32);
    module.dispose();
    const fresh = await instantiateGraphics(binary, 8, 8, 0);
    expect(fresh.render({ width: 8, height: 8, elapsed: 0, delta: 0 })[0]).toBe(
      0,
    );
  }, 20000);
  it("rejects invalid source, oversized source and imports", async () => {
    await expect(
      compileGraphics(
        'import { secret } from "./private"; export function run():void { secret(); }',
      ),
    ).rejects.toThrow("compilation failed");
    await expect(compileGraphics("not valid assemblyscript!")).rejects.toThrow(
      "compilation failed",
    );
    await expect(compileGraphics("x".repeat(64001))).rejects.toThrow("64000");
    const binary =
      await compileGraphics(`@external("evil", "fetch") declare function fetch():void;
      export function init(w:i32,h:i32,i:i32):void {fetch();}
      export function render(w:i32,h:i32,t:f64,d:f64):usize{return 0;}
      export function dispose():void {}`);
    await expect(instantiateGraphics(binary, 8, 8, 0)).rejects.toThrow(
      "restricted",
    );
  });
  it("rejects out-of-memory reads, traps and invalid dimensions", async () => {
    const binary = await compileGraphics(
      source.replace("return changetype<usize>(pixels);", "return 16777215;"),
    );
    const module = await instantiateGraphics(binary, 8, 8, 0);
    expect(() =>
      module.render({ width: 8, height: 8, elapsed: 0, delta: 0 }),
    ).toThrow("invalid RGBA");
    for (const width of [0, 1025, NaN, 1.5])
      expect(() =>
        validateFrame({ width, height: 8, elapsed: 0, delta: 0 }),
      ).toThrow();
  });
});
