# Microscopes and walkthroughs

A microscope belongs to a notebook cell. Its main content is a walkthrough: a
title and ordered steps with display-only code, explanatory Markdown and named
line or character annotations. Each step shows its title and Markdown above a
notebook-style container with read-only code left and an optional graphics canvas right.
Code uses the notebook's syntax highlighting. Steps may also provide separate
`playground_code` for an isolated executable playground. Optional AssemblyScript
graphics compile and execute in browser workers; see [walkthrough-graphics.md](walkthrough-graphics.md).
It works in the Rust server and the
static browser build; the legacy Python rollback gateway does not implement it.

## Use

Agents call `create_microscope` with `notebook_path`, `cell_id`, `title` and a
required, nonempty `walkthrough`. Creation saves the entire document in one call.
The result includes a seven-character `microscope_id`. `list_microscopes` reads
the references for that notebook/cell. `open_microscope` takes the same scope and
ID; `close_microscope` takes the notebook path. `get_active_context` reports
`view: "microscope"` and a nullable `microscope` object containing its target,
loaded state and walkthrough context.

Use `update_microscope` to replace the complete saved walkthrough and its title.
The ID and owning cell stay unchanged; omitted steps/annotations are removed.
`set_microscope_walkthrough` remains a compatibility alias. Updating
requires the notebook path, cell ID, microscope ID and this `walkthrough` object:

```json
{
  "title": "Understanding the result",
  "steps": [
    {
      "id": "assignment",
      "title": "Assign a value",
      "code": "value = 40 + 2\nvalue",
      "playground_code": "value = 40 + 2\nprint(value)",
      "markdown": "The expression evaluates to **42**. The variable keeps it for later cells.",
      "annotations": [
        {
          "id": "sum",
          "start_line": 1,
          "end_line": 1,
          "start_column": 9,
          "end_column": 14,
          "text": "Evaluate the sum and bind the result.",
          "color": "blue"
        }
      ]
    }
  ]
}
```

Step and annotation IDs are stable, unique within their parent, 1–64 ASCII
letters/digits/underscores/hyphens. Annotation ranges are **one-based and
inclusive**. Available colors are `blue`, `blue-light`, and `blue-deep`.
Annotations and code are saved content; code is never executed or copied into
the owning notebook cell. Highlighted code is shown in a numbered, read-only left
pane; Markdown is rendered above it using the existing bounded renderer.

## Temporary playgrounds

A step with `playground_code` has a play button. Its code may differ from the
displayed excerpt: include imports and setup because the kernel starts fresh,
without the parent notebook's variables. `playground_code` is optional, nonblank
when present, and bounded to 64,000 UTF-8 bytes within the document aggregate limit.

The playground opens as a bounded window above the still-visible Microscope stage,
using the existing single-cell editor, completion, run/interrupt and output
controls. **Close playground** stops the temporary kernel and discards edits,
outputs and variables. Closing the window and the WebMCP close operation share
that cleanup path. Saved step source and the original notebook remain unchanged.
Only one playground is active at a time. While mounted,
`get_active_context().context` reports `view: "playground"`; its `playground`
object keeps owner and step identity, draft text, exact executing source/status,
execution count and current outputs distinct. Replacement/deletion of its microscope
or leaving the notebook closes it.

WebMCP offers `open_playground` (notebook/cell/microscope scope and zero-based
step index), `read_playground`, `execute_playground` (optional replacement source),
and `close_playground`, all scoped to a notebook. Execution uses the same validated
command gateway as the human editor. Agent shell/package-install magics are rejected.

Server mode creates a dedicated Jupyter session/kernel without saving a temporary
notebook file. Only the workspace driver can open, edit, execute or close it.
Opted-in followers see its code and outputs read-only through bounded snapshots
polled every 500 ms; execution progress to the driver uses the existing NDJSON
stream. Driver loss or a 60-second missing owner heartbeat triggers cleanup on
the five-second reaper. Failed cleanup stays marked closing and is retried.
This is kernel-state isolation, **not a security sandbox**: the kernel still has
the configured runtime's filesystem/network permissions.

Browser mode is local-only and uses a separate Pyodide worker and in-memory
notebook store, never the parent's kernel or persisted notebook. Workspace files
are not mounted into this temporary worker. Closing terminates the worker.
Browser-to-browser following is intentionally unsupported.

- `read_microscope` returns the saved document, including its walkthrough.
- `focus_microscope_step` opens a **zero-based** `step_index`, clearing temporary
  annotation focus. Humans use the left/right chevron buttons, Left/Right arrow
  keys, or the step dropdown. Up/Down cycles the current step's annotations;
  Backspace returns to the notebook. These shortcuts are microscope-only and
  do not override playground editing or an open step dropdown.
- `focus_microscope_annotation` takes `step_index` and `annotation_id`, opens the
  step, scrolls the code range into view and pulses its outline. Reduced-motion
  viewers get a static outline instead.
- `clear_microscope_focus` clears the pulse in the addressed, currently open
  microscope. The step and saved annotations remain. Humans can also use Clear
  focus or select another annotation.
- `capture_microscope_step` captures the current stage background and positioned
  overlays as a bounded PNG for agent visual feedback; fixed navigation is omitted.
  It takes no arguments because it captures the active view. Large captures are
  downscaled and report both returned and source dimensions.
- `get_active_context().context.microscope.walkthrough` reports `title`, `step_index`,
  `step_count`, `step_id`, and nullable `annotation_id`. UI numbering starts at 1.

Authoring requires the server workspace driver; reading and local navigation do
not. Opted-in followers receive step and annotation focus together with the
microscope target and its content revision. They reload through the command queue
when the driver's content revision changes. Focus is in-memory presentation state,
not a notebook edit. A page reload restores the saved document, not its view state.

Cells with microscopes have a top-right **microscope icon** dropdown (with a
Microscopes tooltip). The workspace explorer hides their sidecar rows and shows
a muted microscope icon and total sidecar count beside the owning notebook.
An orphan sidecar without a matching notebook stays visible for recovery.
Select a title
to enter its shell. **Back to notebook** returns to the notebook without deleting
anything. The cross next to each title opens an explicit deletion confirmation;
confirmation deletes both reference and content file. There is no agent deletion
tool. Server-side creation/deletion require the workspace driver, including
direct API commands. Reading and local navigation are available to observers.

Only one microscope can be loaded in the active notebook area. Switching replaces
the previous shell; leaving/closing a notebook disposes it. Navigation is local
unless Follow is enabled: followers mirror the driver's notebook, microscope
target (or notebook mode), selection and scroll through the existing follow
transport. View events may precede metadata events, so followers refresh through
the shared command queue before loading a target. Browser mode remains single-user.

## Metadata and storage

Cell metadata contains only the versioned references:

```json
{
  "didaction_microscopes": {
    "schema_version": 1,
    "items": [{ "id": "abc1234", "title": "A closer look" }]
  }
}
```

The filename is derived, never supplied by callers:
`notebook.ipynb.<cell-hash>.<microscope-id>`, alongside the notebook, including
inside subfolders. The cell hash is FNV-1a truncated to 28 bits, encoded as seven
lowercase hex characters. IDs are seven lowercase letters/digits; generated IDs
currently use seven UUID hex digits. They are locators, not secrets. Collisions
reject rather than overwrite. Each file is JSON with `schema_version`, the full
`notebook_path`, full `cell_id`, and `microscope: {id, title}`. Loading checks this
full binding against notebook metadata, not just the short filename. References
also carry a monotonically increasing `revision` after the first walkthrough save;
legacy references without one mean revision zero. Documents add an optional
`walkthrough` field for legacy decoding. New creation requires it; existing empty
shell files are preserved for explicit repair with `update_microscope` or human
deletion, rather than silently removed.

The protocol permits at most 16 references per cell and titles of 1–128 UTF-8
bytes without control characters. Existing notebook, metadata, response and
workspace bounds still apply. Unknown schema versions/fields are rejected. The
document is bounded to 512,000 serialized UTF-8 bytes. Walkthroughs have 1–64
steps, 1–128-byte titles, at most 64,000 bytes each of code and Markdown per step,
and at most 32 annotations per step, each with 1–4,096 bytes of explanation.
Annotations always have inclusive, one-based line ranges. They may also include
both `start_column` and `end_column` to highlight an inclusive range within one
line. Columns count Unicode characters (not UTF-8 bytes); partial ranges cannot
span lines. Omitting both columns highlights the complete line range.
The aggregate walkthrough bound leaves 4 KiB for its ownership envelope. Unknown
fields are rejected, including arbitrary scripts and kernel configuration. The
optional `graphics` definition accepts only the versioned AssemblyScript RGBA interface.

Rust's `notebook-protocol::microscope` owns the schema and derivation; core/runtime
own validated transitions. Both egui and WebMCP use the same command gateway for
`create_microscope`, `set_microscope_walkthrough`, `delete_microscope`, and
`read_microscope`. WASM does no I/O.
Browser IndexedDB commits metadata and artifact in one two-store transaction.
The native gateway accesses both files through Jupyter Contents, not host paths.

## Failure and lifecycle boundaries

Jupyter Contents has no multi-file transaction. The native gateway serializes
workspace file operations, writes/deletes the sidecar first, then saves notebook
metadata. If the save acknowledgement fails, it reads back the notebook. A matching
saved document counts as success. A confirmed failed create is compensated by
removing the new sidecar; a failed delete restores its full sidecar, including
walkthrough content. A confirmed failed metadata save after a walkthrough update
restores the previous document. IndexedDB updates compare the expected previous
sidecar and atomically replace it with the notebook metadata. Failed compensation
or a crash can still leave an orphan/missing file: this is not crash-atomic storage.
Errors do not claim success; refresh and inspect before retrying. A missing file
has an actionable load error and can be removed with the human delete action.
Never automatically delete files with an unverified ownership binding.

Ordinary cell mutations cannot forge/copy microscope references or delete a cell
that still owns them. Notebook rename is also blocked while references exist;
delete microscopes first. Automatic rename/copy bundling, orphan recovery,
human content authoring, microscope navigation persistence across reload, and concurrent
external Jupyter editors are not implemented in this step. Preserve sidecars when
moving a workspace; do not copy an attached notebook alone and expect content to
follow it. **Export workspace** bundles notebooks and sidecars together as a ZIP.
The Rust server reads recursively through confined Jupyter Contents, with a
60-second timeout, 1 MB per-file and 20 MB total bounds (plus ZIP overhead in the
browser). Namespace changes are blocked during export; notebook edits from other
clients or external Jupyter editors are not a workspace-wide transactional snapshot.
Pause collaborative edits before making a consistent backup. The legacy Python
rollback gateway does not implement workspace export.

## Verification

Protocol tests cover identity, metadata preservation and rejected references.
Walkthrough tests cover bounds, duplicate IDs, malformed ranges, content revisions
and focused annotation validation. `tests/browser-kernel/walkthrough.spec.ts`
tests agent authoring, real egui Previous/Next controls, focus/clear, rejected
updates, unchanged source cells, replacement and reload persistence.
`tests/browser-kernel/microscope.spec.ts` covers real WASM, IndexedDB, registered
WebMCP handlers, the egui shell/dropdown, human deletion and reload persistence.
The Rust native smoke scenario checks real Jupyter sidecar updates, metadata, idempotency
and observer rejection. `tests/browser/follow.spec.ts` checks microscope following
and independent observer navigation against the real gateway, including walkthrough
step/annotation following and driver-only authoring.
