---
name: didaction notebook
description: A familiar local notebook shared safely by people and browser tools.
colors:
  brand-orange: "#d66b2c"
  focus-blue: "#2d698f"
  ink: "#263238"
  muted-ink: "#53636b"
  canvas: "#f7f7f7"
  surface: "#ffffff"
  divider: "#d7dcdf"
  selected-cell: "#fafdff"
  selection-blue: "#d2e8f6"
  output-surface: "#f8fafb"
  warning-surface: "#fff8e8"
  warning-divider: "#ead49e"
  success: "#2e7d32"
  pending: "#ef6c00"
  running: "#0277bd"
  danger: "#c62828"
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "normal"
rounded:
  none: "0px"
  cell: "3px"
spacing:
  tight: "8px"
  cell-inset: "10px"
  compact-gutter: "12px"
  page-gutter: "16px"
  shell-gutter: "20px"
  dialog-inset: "28px"
components:
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "7px 12px"
  button-default-hover:
    backgroundColor: "#eef4f7"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "7px 12px"
  cell-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.cell}"
    padding: "{spacing.cell-inset}"
  cell-selected:
    backgroundColor: "{colors.selected-cell}"
    textColor: "{colors.ink}"
    rounded: "{rounded.cell}"
    padding: "{spacing.cell-inset}"
  output-panel:
    backgroundColor: "{colors.output-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: "{spacing.tight}"
  privacy-note:
    backgroundColor: "{colors.warning-surface}"
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "8px 20px"
---

# Design System: didaction notebook

## Overview

**Creative North Star: "The Familiar Local Notebook"**

didaction should feel like opening the original Jupyter Notebook on a trusted local machine: a quiet vertical document, compact IDE chrome, and controls that stay close to the work. Familiarity is functional here. It lets a person read cells, edit code, execute, inspect output, recover the kernel, and resume without first learning a new interface language.

The visual system is deliberately utilitarian rather than expressive. White working surfaces sit on a nearly white canvas; thin dividers organize the shell; selection, focus, and kernel state receive the strongest color. The egui canvas explicitly uses light visuals so system preference cannot change this material grammar. The small orange wordmark is the only persistent brand accent. There are no decorative illustrations, floating panels, gradients, or ornamental motion.

**Key Characteristics:**

- Document-led vertical notebook flow.
- Compact, desktop-IDE chrome that wraps cleanly on narrow screens.
- Explicit light-mode egui primitives with Jupyter-familiar menus, toolbar icons,
  cell-type control, and execution prompts.
- Flat light surfaces separated by thin rules rather than depth effects.
- Restrained sans-serif interface type paired with monospace code and output.
- Blue emphasis for focus and cell selection; semantic color only for status and risk.
- Quiet state changes with visible, actionable recovery paths.

## Colors

The palette is a cool, paper-like neutral system with one sparse orange identity mark and tightly scoped semantic colors.

### Primary

- **Notebook Blue:** Used for visible keyboard focus, active cell borders, and selection. It identifies the current place of work, never decoration.
- **Didaction Orange:** Reserved for the small product wordmark. Its rarity keeps branding recognizable without competing with notebook content.

### Secondary

- **Running Blue:** Marks active execution in the kernel status strip.
- **Saved Green:** Confirms synchronized notebook state.
- **Pending Orange:** Marks dirty or pending state without borrowing the product-brand accent as a general highlight.
- **Action Red:** Marks disconnection, failures, and requests that require intervention.

### Neutral

- **Charcoal Ink:** Default UI text and headings against light surfaces.
- **Slate Metadata:** Secondary shell labels, status text, and the persistent trust notice.
- **Notebook Canvas:** The continuous page behind the ordered cell document.
- **Paper Surface:** Header, cells, controls, and bounded error panels.
- **Hairline Divider:** Shell boundaries and ordinary cell edges.
- **Selected Paper:** A barely blue working surface inside the active cell.
- **Output Wash:** Subtle tonal separation for committed output.
- **Trust Wash:** Warm, quiet background and divider for the local-execution warning.

### Named Rules

**The Color Has a Job Rule.** Outside the wordmark, color must indicate focus, selection, synchronization, execution, warning, or failure.

**The Current Cell Rule.** The selected cell uses both a stronger blue edge and a barely tinted surface, so selection remains clear without filling the document with color.

## Typography

**Display Font:** None; this is a working tool, not a promotional surface.

**Body Font:** System UI sans-serif with the operating system's native fallback stack.

**Label/Mono Font:** System monospace for prompts, source, output, and execution counts.

**Character:** The interface type is neutral and compact; the monospace layer makes executable material unmistakable. Weight does little hierarchy work. Size, placement, dividers, and semantic grouping carry the structure.

### Hierarchy

- **Title:** A compact, regular-weight notebook title used once at the head of the canvas toolbar.
- **Body:** Default control labels, empty-state guidance, and bounded error copy.
- **Label:** Small shell metadata, connection status, revision details, and the trust notice.
- **Code:** Monospace source, prompts, output, and tracebacks with a stable line rhythm.

### Named Rules

**The Code Stays Code Rule.** Prompts, editable source, execution results, and tracebacks always use monospace; surrounding controls and system status always use the UI sans.

## Layout

The screen is a three-row shell: a compact connection header, a notebook canvas that consumes the remaining height, and a persistent trust note. Inside the canvas, the toolbar and status strip remain pinned to their respective edges while the central cell document scrolls vertically.

Cells form a single ordered column with a maximum working width of 1120px. The document uses a 16px horizontal gutter and 12px vertical inset, 10px between cells, and 10px within each cell. Cell editors expand from two to eighteen visible lines before their surrounding document flow carries the rest of the work.

At widths below 640px, browser-shell gutters contract to 12px and the secondary “local notebook” label disappears. At widths below 600px, egui controls become 44px tall and wrapped toolbars form additional rows. Each cell action row also wraps, with separators preserving the execution, insertion/duplication, type-conversion, movement, and destructive groups. Cell order, output adjacency, kernel status, and the trust notice remain intact; horizontal overflow is not part of the interaction model.

### Named Rules

**The Document Owns the Viewport Rule.** Chrome stays compact so working cells, output, and kernel state remain visible together whenever the viewport allows it.

**The Narrow Screen Preserves the Task Rule.** Controls may wrap and secondary labels may disappear, but execution, recovery, status, and the ordered cell document remain available.

## Elevation & Depth

The system is flat. It uses no shadows. Depth comes from white working surfaces against the light gray canvas, thin structural dividers, an inset output wash, and the stronger edge on the selected cell.

### Named Rules

**The Flat Notebook Rule.** Do not use shadows, glass, gradients, or floating cards to separate ordinary notebook regions; use tonal surfaces and one-pixel rules.

## Shapes

The shell and browser-level controls are square. Notebook cells have only a gently softened 3px corner so their borders read as document containers rather than cards. Status dots are the one recurring circular form, used as compact state markers.

**The Almost-Square Rule.** Corners should feel structural and tool-like. Do not introduce pill controls or large card radii.

## Components

### Shell Header

- **Structure:** A 48px-minimum white row with product identity at the left and connection/WebMCP status at the right.
- **Branding:** The orange wordmark is bold; the adjacent product descriptor is quieter and may disappear on narrow screens.
- **Boundary:** A single hairline divider separates the header from the notebook canvas.

### Toolbar

- **Character:** The familiar Jupyter hierarchy: notebook title, menu row, then a compact icon toolbar grouped by separators and allowed to wrap.
- **Actions:** Save, insert below, move up/down, run selected, interrupt, restart, and selected-cell type appear in Jupyter order. Less frequent supported actions live in File, Edit, View, Insert, Cell, Run, and Kernel menus. Reconnect appears only when disconnected.
- **State:** Commands are disabled while a mutation or execution makes them unsafe; control availability communicates command validity without noisy animation.
- **Commit behavior:** “Run all” flushes every visible dirty source before queuing code-cell execution, so the notebook runs what the user can see.

### Notebook Explorer

- **Structure:** A flat white sidebar beside the notebook canvas, separated by a hairline divider, with a 12px inset and independent vertical scrolling. Its expanded width is 248px, reducing to 180px at viewport widths of 640px or less; collapsing it returns that space to the document.
- **Controls:** An outlined sidebar icon is the first egui toolbar button, immediately before Save, using the same sizing and styling. Its tooltip reflects Show/Hide state. A focus-revealed DOM equivalent retains keyboard and screen-reader access. The sidebar shows a “Notebooks” heading, a wrapping workspace-relative folder path, and explicit Up and Refresh actions; Up is disabled at the workspace root.
- **Rows:** Full-width, left-aligned buttons pair small outlined SVG folder or notebook icons with wrapping names. The current notebook uses the existing blue selection surface and an accessible current-page marker; icons are decorative, while names and path tooltips identify entries.
- **Navigation:** Folders open in the sidebar without replacing the notebook. Opening another notebook is guarded: unsaved edits or active execution keep the current document open and show guidance to save and wait before switching.
- **Feedback:** Quiet status text reports loading, entry counts, empty folders, or actionable recovery through Up or Refresh. Controls retain the existing square form, restrained hover treatment, and visible keyboard focus.

### Notebook Cell

- **Shape:** A nearly square bordered container with a small inner inset.
- **Selection:** The active cell receives a 2px blue edge and a barely blue surface; inactive cells use a 1px neutral edge and white surface.
- **Header:** A compact drag target and monospace execution prompt identify the cell. Notebook actions remain in the stable top toolbar and menus instead of repeating inside every cell.
- **Editor:** Multiline monospace editing fills the available width, grows within bounded visible lines, and selects its cell on focus or click.
- **Markdown:** Markdown cells open rendered. Double-clicking rendered content enters source editing; the explicit Render Markdown action returns to the document view.
- **Commit behavior:** Changed source flushes on focus loss. Run, keyboard Run, insertion, duplication, conversion, movement, and deletion flush the visible source before their serialized mutation or execution commands, keeping actions aligned with the text on screen.

### Output

- **Style:** Monospace content on a subtle cool wash directly beneath its source cell.
- **Behavior:** Text and streams remain plain; errors combine name, message, and traceback; rich output shows its MIME type and bounded data rather than simulating a separate renderer.

### Status Strip

- **Structure:** A compact bottom row with a colored state dot, synchronization label, kernel name/state, and notebook revision separated by rules.
- **Failure:** The status label becomes “Action required” and a second line explains whether to retry/reconnect or edit the request.

### Browser Button

- **Shape:** Square, thin-bordered, white control with compact padding.
- **Hover:** A cool gray-blue surface change with no transform or decorative transition.
- **Focus:** The global 3px blue outline remains fully visible with a 3px offset.

### Fatal Error

- **Structure:** A bounded white panel, no wider than 640px, centered within the notebook region with a plain heading, specific message, and Retry action.
- **Purpose:** Startup failure replaces the unusable canvas rather than leaving an ambiguous blank state.

### Trust Notice

- **Style:** A persistent warm strip below the notebook with small slate text and a thin amber divider.
- **Copy:** Directly states that local execution is unsafe and asks the user to run only trusted notebooks.

## Do's and Don'ts

### Do:

- **Do** keep the vertical notebook document, its ordered cells, and each output directly adjacent to its source.
- **Do** reserve blue for focus, selection, and running state; reserve green, orange, and red for explicit system meaning.
- **Do** preserve visible keyboard focus and touch-sized controls at narrow widths.
- **Do** keep selected-cell primitives in the stable Jupyter toolbar order, with descriptive hover text and equivalent menu labels.
- **Do** keep failures bounded, specific, and paired with the next valid recovery action.
- **Do** show synchronization, kernel state, and revision as quiet persistent metadata.

### Don't:

- **Don't** turn cells into elevated cards or distribute them across a dashboard grid.
- **Don't** add decorative motion, gradients, glass effects, or oversized brand moments.
- **Don't** hide interrupt, restart, reconnect, or failure guidance behind icon-only controls.
- **Don't** use proportional type for code, prompts, output, or tracebacks.
- **Don't** let responsive wrapping reorder the execution story or separate output from its cell.
