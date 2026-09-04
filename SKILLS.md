# Designing Microscopes

Use this guide whenever an agent creates, revises, or visually evaluates a
Microscope. A Microscope is a cell-owned, step-by-step explanation combining a
short description, focused code, annotations, optional playground code, and
animated graphics.

## Required WebMCP loop

Use the live application's WebMCP tools for all Microscope work. The live schemas
are authoritative and may change before production.

1. Inspect the available WebMCP tools and their current input schemas.
2. Call `get_active_context`, then `list_microscopes` for the selected cell.
3. Call `read_notebook` and locate the selected executable cell in notebook order.
   Read its source and outputs together with its grouped Markdown partner when
   `markdown_grouped` is true. Otherwise inspect the nearest preceding Markdown
   cell and, when relevant, the nearest following Markdown cell. Use these cells
   as candidate context for the author's goal, terminology, assumptions, and
   expected result; resolve them against what the code actually does.
4. Write a short portrayal brief in plain language before choosing coordinates or
   writing graphics code. State what the learner should understand, which objects
   participate, what relationship or change must become visible, and what should
   attract attention first. The brief is a design aid, not canvas text.
5. Derive the graphics regions from that brief. Give each region one visual job,
   identify any shared background or overlap, and name the annotation targets.
   Use one region when one responsive composition is clearer; add regions only
   for elements that benefit from independent placement, animation, or layering.
6. Call `read_microscope` before revising an existing Microscope. Updates replace
   the complete walkthrough, so preserve every deliberate step and field.
7. Use `create_microscope` or `update_microscope` with the full walkthrough.
8. Use `open_microscope` or `focus_microscope_step` to display the intended step.
9. Use `focus_microscope_annotation` for every important annotation and verify
   that its highlight or callout lands on the intended target.
10. Call `capture_microscope_step` after every meaningful visual revision. Inspect
    the returned PNG, not just the JSON. Iterate until the composition is clear at
    the current viewport size.
11. Accept a step only when every graphics region reports `error: null` and
    `frames > 0`, with no clipping, overlap, unreadable text, or accidental boxes.

If WebMCP is unavailable or capture fails, report that limitation instead of
claiming the visual design was verified through another path.

## Teaching design

Teach one clear concept per step. Make the step title state the idea plainly; the
navigation already renders it, so omit title text from the canvas. Keep the fixed
description short and explanatory. It supports CommonMark and inline math such as
`$f(x)=x^2$`; prefer math notation when it communicates more precisely.

Use the stage as a visual explanation, not a slide full of prose. Prefer motion,
spatial relationships, arrows, causal connections, and a restrained, consistent
color vocabulary. Give each step a topic-specific diagram rather than recoloring
one generic animation. Use code only for the lines being taught. Put experiments
in `playground_code`, which opens in a separate movable, resizable temporary
window with a fresh kernel.

Annotations should explain both what a target does and why it matters. A
`code_range` targets one-based inclusive lines and optional same-line Unicode
columns. A `graphics_point` targets a 0–1000 point local to a named graphics
region. Place graphic points on the object being explained, then verify their
callouts with `focus_microscope_annotation` and a capture.

## Responsive composition

The stage and each graphics region use normalized thousandths:

```text
stage_x = round(pixel_x / stage_pixel_width * 1000)
stage_y = round(pixel_y / stage_pixel_height * 1000)
```

Specify `code_bounds` and each region's `bounds` relative to the stage, not the
browser window. Leave breathing room between code and the main diagram. Code owns
its bounded scrolling viewport, so give it enough width for the important lines
without allowing it to dominate the explanation.

Graphics receive their region's current physical `width` and `height`, capped at
1024 by 768. Derive every position and size from those arguments. Never assume the
dimensions remain fixed: resize is part of the acceptance check.

Use multiple graphics regions when independent animated elements improve the
lesson. Array order is paint order. The stage background is painted once, followed
by each region. Region pixels alpha-composite onto the shared stage; regions do
not need visible containers.

## AssemblyScript RGBA contract

Each region uses `language: "assemblyscript-rgba-1"` and exports exactly:

```ts
const MAX_WIDTH: i32 = 1024;
const MAX_HEIGHT: i32 = 768;
const pixels = new StaticArray<u8>(MAX_WIDTH * MAX_HEIGHT * 4);

function clear(width: i32, height: i32): void {
  const length = width * height * 4;
  for (let i = 0; i < length; i++) pixels[i] = 0;
}

function setPixel(
  x: i32,
  y: i32,
  width: i32,
  height: i32,
  r: u8,
  g: u8,
  b: u8,
  a: u8 = 255,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
}

export function init(width: i32, height: i32, stepIndex: i32): void {}

export function render(
  width: i32,
  height: i32,
  elapsed: f64,
  delta: f64,
): usize {
  clear(width, height);
  // Paint only the intended element. Scale geometry from width and height.
  return changetype<usize>(pixels);
}

export function dispose(): void {}
```

Keep unused pixels transparent (`alpha = 0`). Use the step or region `background`
field for a deliberate base color. Filling an entire region with opaque pixels
covers earlier layers and creates the rectangular artifacts users perceive as
boxes. The buffer uses straight, unpremultiplied RGBA.

Allocate the fixed `StaticArray<u8>` once. Allocate no arrays or managed objects
inside `render`. Bounds-check every pixel write. Use `elapsed` for meaningful
animation and `delta` only when frame-to-frame integration is necessary. A static
frame should still communicate the concept when reduced motion pauses animation.

## Visual feedback checklist

Review the PNG returned by `capture_microscope_step` at least once per step and
again after layout or graphics changes.

- The title and short description establish the lesson without canvas duplication.
- The eye reaches the main relationship before secondary details.
- Code, diagram elements, hover targets, and callouts do not overlap accidentally.
- Text is concise, legible, and fully visible; math sits inline where intended.
- Code annotations visibly isolate the relevant range.
- Graphic annotations point to meaningful objects rather than empty coordinates.
- Animation explains change or causality instead of adding decoration.
- Transparent space remains transparent; no unintended region rectangles appear.
- The composition remains useful after narrowing and widening the workspace.
- Every region has `error: null` and `frames > 0`.

For the storage and UI contract, read `docs/microscope.md`. For worker lifecycle,
performance limits, compositing, and attachment rules, read
`docs/walkthrough-graphics.md`.
