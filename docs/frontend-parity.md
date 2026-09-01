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
|     2 | Real kernelspec/session              | Supported        | Direct Sessions/Kernels REST; IPython acceptance kernel.                                                                                  |
|     3 | Edit code cells                      | Supported        | Python highlighting, line numbers, multiline editing, and committed draft flushing via pinned `egui_code_editor 0.2.17`.                  |
|     4 | Add above/below                      | Visual parity    | Familiar Insert menu and top-toolbar insert-below control; empty cells supported.                                                         |
|     5 | Delete, duplicate, move              | Visual parity    | Edit menu, top-toolbar move controls, and optional drag-handle reordering with a visible drop line.                                       |
|     6 | Code/Markdown/raw conversion         | Visual parity    | Familiar selected-cell type dropdown; conversion preserves stable identity and source.                                                    |
|     7 | Run cell and run all                 | Visual parity    | Familiar Run menu and play control; real kernel-channel execution with bounded persisted outputs.                                         |
|     8 | Text, stream, error outputs          | Supported        | Execution count and bounded traceback rendering.                                                                                          |
|     9 | Basic graphs                         | Supported        | Bounded PNG and SVG output; seeded executable SVG example.                                                                                |
|    10 | Kernel completion                    | Supported, basic | Tab requests `complete_request`; the editor dropdown supports mouse, ↑/↓, Enter, Tab, Escape, and restores the caret after inserted text. |
|    11 | Interrupt/restart/reconnect          | Visual parity    | Familiar stop/restart toolbar position plus Kernel menu; native kernel lifecycle and path-based session reuse.                            |
|    12 | Browser restart persistence          | Supported        | Notebook on disk plus reusable path-associated Jupyter session.                                                                           |
|    13 | Keyboard notebook flow               | Supported, basic | Command/edit indicator, Escape, A/B, Cmd/Ctrl+Enter, Tab.                                                                                 |
|    14 | Markdown rendering                   | Visual parity    | Opens rendered by default; double-click enters source editing; headings, lists, and paragraphs are bounded.                               |
|    15 | Actionable failure/disconnect states | Supported        | Visible status, typed errors, reconnect action.                                                                                           |
|    16 | Credential and path safety           | Supported        | Same-origin gateway, server-side token, confinement and bounds.                                                                           |

## Most-used primitives after the mandatory tier

| Order | Primitive                   | Current status | Next parity step                                               |
| ----: | --------------------------- | -------------- | -------------------------------------------------------------- |
|     1 | Shift+Enter run-and-advance | Partial        | Add exact focus/selection advance semantics.                   |
|     2 | Cut/copy/paste cells        | Not yet        | Bounded internal cell clipboard and multi-cell selection.      |
|     3 | Undo/redo structure         | Not yet        | Deterministic command history in `notebook-core`.              |
|     4 | Clear outputs               | Not yet        | Add typed one-cell/all-cells mutations.                        |
|     5 | Continuous completion       | Not yet        | Cursor-aware debounce, cancellation, selection popup.          |
|     6 | Signature/object help       | Not yet        | Bounded `inspect_request` UI.                                  |
|     7 | Find/replace                | Not yet        | Notebook and active-editor scopes.                             |
|     8 | Full Markdown + math        | Partial        | CommonMark, links, fenced code, safe HTML, MathJax-equivalent. |
|     9 | Table/HTML rich display     | Not yet        | Sanitized renderer with strict MIME allowlist.                 |
|    10 | Notebook rename/download    | Not yet        | Confined Contents operations and browser download.             |
|    11 | Cell collapse/line numbers  | Not yet        | Persisted view metadata and editor gutters.                    |
|    12 | Autosave/checkpoints        | Not yet        | Debounced save status and Contents checkpoints.                |

## Intentionally deferred

Widgets/comms, debugger, terminal, file browser, multi-user Yjs collaboration,
JupyterLab extensions, arbitrary HTML/JavaScript, package installation, notebook
trust/signing UI, slideshow tooling, and full JupyterLab workbench parity. Each
requires a separate security and protocol design; none falls through to generic
Jupyter calls.

## Examples

The default `notebook-parity-demo.ipynb` is seeded on first startup with:

1. Markdown instructions.
2. A Python list and expression for editing, execution, and completion.
3. An IPython `SVG` bar graph generated without optional plotting packages.

Run the first code cell, press Tab after a partial expression such as
`values.co`, select a candidate, then run the graph cell. The outputs originate
from the same real IPython kernel and persist in the notebook.
