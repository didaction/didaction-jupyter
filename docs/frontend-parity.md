# Jupyter Notebook frontend parity

Status reflects this branch after the direct-Jupyter implementation. Priorities
are ordered first by what is mandatory for a dependable code-first notebook,
then by commonly used notebook primitives. “Supported” covers real behavior;
“visual parity” additionally means a Jupyter user can find the action in its
familiar region, recognize its control, and get the expected selected-cell
behavior. See the [primary-source parity reference](jupyter-frontend-parity-reference.md).

## Mandatory

| Order | Primitive                            | Status           | Notes                                                                                                                                     |
| ----: | ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Open/create/save `.ipynb`            | Supported        | Direct Contents REST, nbformat validation, stable cell IDs.                                                                               |
|     2 | Real kernelspec/session              | Supported        | Direct Sessions/Kernels REST; the kernelspec is fixed by `DIDACTION_KERNEL_NAME` at startup and IPython is the acceptance kernel.         |
|     3 | Edit code cells                      | Supported        | Python highlighting, line numbers, multiline editing, and committed draft flushing via pinned `egui_code_editor 0.2.17`.                  |
|     4 | Add above/below                      | Visual parity    | Familiar Insert menu and top-toolbar insert-below control; empty cells supported.                                                         |
|     5 | Delete, duplicate, move              | Visual parity    | Edit menu, top-toolbar move controls, and optional drag-handle reordering with a visible drop line.                                       |
|     6 | Code/Markdown/raw conversion         | Visual parity    | Familiar selected-cell type dropdown; conversion preserves stable identity and source.                                                    |
|     7 | Run cell and run all                 | Visual parity    | Familiar Run menu and toolbar control plus a per-cell play button with in-progress and completed states; real kernel execution.           |
|     8 | Text, stream, error outputs          | Supported        | Execution count and bounded traceback rendering.                                                                                          |
|     9 | Basic graphs                         | Supported        | Bounded PNG and SVG output; seeded executable SVG example.                                                                                |
|    10 | Kernel completion                    | Supported, basic | Tab requests `complete_request`; the editor dropdown supports mouse, ↑/↓, Enter, Tab, Escape, and restores the caret after inserted text. |
|    11 | Interrupt/restart/reconnect          | Visual parity    | Familiar stop/restart toolbar position plus Kernel menu; restart confirmation, native lifecycle, and path-based session reuse.            |
|    12 | Browser restart persistence          | Supported        | Notebook on disk plus reusable path-associated Jupyter session.                                                                           |
|    13 | Keyboard notebook flow               | Supported        | Command/edit indicator, Escape, Enter, A/B, M/Y/R/O, Shift+Enter, Alt+Enter, Cmd/Ctrl+Enter, Tab, and edit-history shortcuts.             |
|    14 | Markdown rendering                   | Visual parity    | CommonMark opens rendered by default; double-click or Enter edits; rich Markdown, typeset math, and bounded base64 images.                |
|    15 | Actionable failure/disconnect states | Supported        | Visible status, typed errors, reconnect action.                                                                                           |
|    16 | Credential and path safety           | Supported        | Same-origin gateway, server-side token, confinement and bounds.                                                                           |

## Most-used primitives after the mandatory tier

| Order | Primitive                   | Current status | Next parity step                                                                                 |
| ----: | --------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
|     1 | Shift+Enter run-and-advance | Supported      | Runs the selected code cell and selects the next cell; Alt+Enter inserts below.                  |
|     2 | Cut/copy/paste cells        | Supported      | Bounded internal clipboard; Shift-click prompts select multiple cells.                           |
|     3 | Undo/redo structure         | Supported      | Reversible insert, update, delete, and move history; failed commands preserve the prior state.   |
|     4 | Clear outputs               | Supported      | Typed selected-cell and all-cell output clearing.                                                |
|     5 | Continuous completion       | Supported      | Cursor-aware 300 ms debounce plus bounded, auto-scrolling keyboard/mouse dropdown.               |
|     6 | Signature/object help       | Supported      | Shift+Tab sends a bounded kernel `inspect_request` and shows an in-cell help panel.              |
|     7 | Find/replace                | Supported      | Notebook-wide next-match and replace-all controls.                                               |
|     8 | Full Markdown + math        | Supported      | `$…$` and `$$…$$` LaTeX are locally typeset with MiTeX, Typst, and embedded math fonts.          |
|     9 | Table/HTML rich display     | Supported      | Markdown tables plus sanitized, script-free readable HTML/table output; arbitrary DOM is denied. |
|    10 | Notebook rename/download    | Supported      | Confined rename and a human-triggered `.ipynb` download.                                         |
|    11 | Cell/output collapse        | Supported      | Separate per-cell and per-output collapse, including command-mode `O`; output data is preserved. |
|    12 | Line-number visibility      | Supported      | Per-code-cell line-number toggles for the current browser session.                               |
|    13 | Autosave/checkpoints        | Supported      | Debounced autosave status and explicit Jupyter Contents checkpoints.                             |

## Intentionally deferred

Widgets/comms, debugger, terminal, file browser, multi-user Yjs collaboration,
JupyterLab extensions, arbitrary HTML/JavaScript, package installation, notebook
trust/signing UI, slideshow tooling, and full JupyterLab workbench parity. Each
requires a separate security and protocol design; none falls through to generic
Jupyter calls.

Kernel selection and the notebook workspace are intentionally not in-notebook
primitives. `DIDACTION_KERNEL_NAME`, `DIDACTION_NOTEBOOK_WORKSPACE`, and
`DIDACTION_NOTEBOOK_PATH` fix them at process startup; browser and WebMCP callers
cannot change them.

## Examples

The default `notebook-parity-demo.ipynb` is seeded on first startup with:

1. Markdown instructions.
2. A Python list and expression for editing, execution, and completion.
3. An IPython `SVG` bar graph generated without optional plotting packages.

Run the first code cell, press Tab after a partial expression such as
`values.co`, select a candidate, then run the graph cell. The outputs originate
from the same real IPython kernel and persist in the notebook.
