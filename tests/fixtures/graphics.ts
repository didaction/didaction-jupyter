/** Example author code, not a built-in primitive or graphics DSL. */
export const waveGraphics = {
  language: "assemblyscript-rgba-1",
  description:
    "Animated sine and cosine waves. Blue is sine; orange is cosine.",
  source: `const pixels = new StaticArray<u8>(1024 * 768 * 4);
export function init(width:i32, height:i32, step:i32):void {}
export function render(width:i32, height:i32, time:f64, delta:f64):usize {
  for (let y=0; y<height; y++) {
    for (let x=0; x<width; x++) {
      let p = 4*(y*width+x);
      let angle = <f64>x/<f64>width * Math.PI*4 - time;
      let s = height*(0.5 - 0.32*Math.sin(angle));
      let c = height*(0.5 - 0.32*Math.cos(angle));
      let sine = Math.abs(y-s)<2;
      let cosine = Math.abs(y-c)<2;
      let axis = Math.abs(y-height/2)<1;
      pixels[p] = sine ? 45 : cosine ? 214 : axis ? 180 : 247;
      pixels[p+1] = sine ? 105 : cosine ? 107 : axis ? 190 : 249;
      pixels[p+2] = sine ? 143 : cosine ? 44 : axis ? 196 : 250;
      pixels[p+3] = 255;
    }
  }
  return changetype<usize>(pixels);
}
export function dispose():void {}`,
};
