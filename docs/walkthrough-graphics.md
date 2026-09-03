# AssemblyScript walkthrough graphics

Walkthrough steps may include up to eight `graphics_regions`, each with normalized
`bounds`, `language: "assemblyscript-rgba-1"`, `source` (1–64,000 UTF-8 bytes)
and `description` (1–1,024 UTF-8 bytes). Use the
existing `create_microscope` or `update_microscope` WebMCP tools: graphics are part
of the complete walkthrough, saved with its other content through the
same validated command path. No extra invocation or notebook mutation API exists.
The description is exposed as accessible hover/help text; provide an explanation
of the visual, not just a filename. Existing document aggregate limits still apply.

Set optional region `artifact` to a unique name such as `orbit.ts` to also save
the AssemblyScript source as an owned workspace file:
`notebook.ipynb.<cell-hash>.<microscope-id>.orbit.ts`. Names are 4–80 ASCII
characters, a letters/digits/underscore/hyphen stem beginning with a letter or
digit, and the `.ts` extension. Paths and duplicate attachment names are rejected.
This currently saves executable graphics **source**, not screenshots or arbitrary
binary assets. Compiled WASM is regenerated in the browser, not persisted.

The walkthrough retains its bounded inline source as the canonical rendering
input and recovery copy. The attachment is an exportable copy; editing it outside
the application does not silently change executed graphics. Update graphics through
`update_microscope` to replace both. Omitted attachments are removed on replacement;
human microscope deletion removes them too. A modified/colliding attachment fails
closed rather than overwriting unrelated content. Existing inline-only graphics
remain valid. Attachments are hidden in the explorer and do not inflate microscope
counts, but are included in workspace ZIP export/import.

Browser storage commits the complete bundle and notebook in one transaction.
The Rust gateway preflights all owned paths via Contents and compensates failed
writes. As with microscope metadata, server storage is not crash-atomic and cannot
protect against concurrent external Jupyter editors. A failed recovery requires
manual inspection; no automatic retry is claimed safe.

## UI behavior

Each animation fills only its region beneath the fixed navigation strip and receives
that region's current physical dimensions after every resize. Regions use integer
thousandths of stage width/height (`x`, `y`, `width`, `height`), remain inside
0..1000, and have a minimum 25/1000 size. Array order controls paint order. A region
and the stage may each specify a `#RRGGBB` background and 0–255 opacity.

The code surface uses `code_bounds` in the same coordinate system and owns its
play control and annotation list. The step's short CommonMark description stays
beside fixed navigation, supports inline `$...$` math, and cannot be arbitrarily
positioned. `graphics_point` annotations place hoverable callouts within a named
region using local normalized coordinates. All normal egui UI paints above graphics
and accepts input normally.

A compact Pause/Resume control freezes or resumes the animation clock. With
reduced motion enabled, it is replaced by the honest status
“Paused · reduced motion”; resizing may still refresh the static frame. Loading
shows “Compiling graphics…”. Failures stay within the graphics area with
“Retry graphics”, leaving the walkthrough explanation and code available.

## Author interface

The host compiles source locally with pinned AssemblyScript 0.28.9. Export:

```ts
const pixels = new StaticArray<u8>(1024 * 768 * 4);
export function init(width: i32, height: i32, stepIndex: i32): void {}
export function render(
  width: i32,
  height: i32,
  elapsed: f64,
  delta: f64,
): usize {
  // Write width * height * 4 tightly packed, unpremultiplied RGBA bytes.
  // Dimensions are physical pixels; time and delta are seconds.
  for (let i = 0; i < width * height; i++) {
    pixels[4 * i] = <u8>(128 + 100 * Math.sin(elapsed));
    pixels[4 * i + 1] = 105;
    pixels[4 * i + 2] = 143;
    pixels[4 * i + 3] = 255;
  }
  return changetype<usize>(pixels);
}
export function dispose(): void {}
```

Authors supply arbitrary algorithms. There is no scene graph, shape vocabulary,
plot primitive or DSL. `tests/fixtures/graphics.ts` contains a complete sine/cosine
example that rasterizes its own curves. This first bridge is **CPU-generated RGBA**,
not direct GPU shaders or guest access to Rust egui. The existing egui/Glow renderer
uploads and clips each resulting texture in its declared walkthrough region.

Allocate reusable storage once: the compiler uses the stub runtime, without a
garbage collector. Per-frame allocations can exhaust the fixed 16 MiB memory.
Frame resolution adapts to the available region and display scale, capped at
1024×768. The host schedules at most roughly 30 frames/second, with one outstanding
frame; this is a ceiling, not a frame-rate guarantee. `init` runs once per entry,
`render` receives updated dimensions on resize. Do not assume dimensions stay fixed.

## Lifecycle and safety

- The compiler is a lazy, separate worker; its production bundle is about 12 MB
  uncompressed. It ships in both static builds, but only loads for graphics.
- Compilation takes only source and fixed compiler settings. No user transforms,
  npm resolution, filesystem callbacks, remote modules or compiler flags.
- A fresh execution worker runs the resulting WASM. Its only allowed imports are
  fixed-size memory and a trapping `abort`. It has no DOM, fetch, notebook, kernel,
  filesystem or WebMCP access. A worker alone is **not** this capability boundary;
  the WASM import allowlist is.
- Compilation has a 30-second deadline; initialization/render have 2-second
  deadlines. A timeout, trap, invalid buffer or compiler error stays in the graphics
  area with Retry. Source diagnostics remain in the UI, not routine logs.
- Leaving the step, hiding the notebook for a playground, or disposing the view
  stops that step's region workers. Opening a playground window no longer hides or replaces the
  stage. Dispose is best-effort with forced termination after 50 ms.
  Re-entry creates fresh state; late worker messages are ignored.
- Pause freezes the animation clock; reduced-motion preferences freeze it too.
  Resize can still request a frame. A hidden tab is suspended when its animation
  callback observes visibility; browser background throttling also applies.
- Server followers render locally with independent clocks. Following shares the
  active walkthrough step, not identical animation phase. Browser mode stays local.

These are application-level restrictions, not a guarantee against browser engine
vulnerabilities or whole-process out-of-memory failures. In particular, compilation
has a deadline but no browser-enforced heap cap; keep source bounds conservative.

`get_active_context().context.microscope.walkthrough.graphics_regions` includes
each region ID, frame count, dimensions, pause state and localized error. It never
includes pixel buffers.
`capture_microscope_step` returns a bounded PNG of the current stage—background
and regions, excluding fixed navigation—so an agent can inspect its composition
and iterate with visual feedback. It takes no arguments and captures the active
microscope. If necessary, the PNG is downscaled to fit the agent transport; the
result reports `source_width`, `source_height`, and `downscaled`.

Run `pnpm test`, `cargo test -p notebook-protocol -p notebook-egui`, and
`pnpm exec playwright test --config playwright.browser-kernel.config.ts graphics.spec.ts`.
The browser test uses actual compiler and execution workers, real WASM validation,
WebMCP authoring, egui textures, resizing, navigation and deliberate failures.
