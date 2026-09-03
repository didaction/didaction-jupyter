# Microscope foundation

A microscope belongs to a notebook cell. This step implements references, durable
sidecar storage and a full notebook-area shell, not walkthrough rendering,
programmable graphics or nested execution. It works in the Rust server and the
static browser build; the legacy Python rollback gateway does not implement it.

## Use

Agents call `create_microscope` with `notebook_path`, `cell_id` and `title`.
The result includes a seven-character `microscope_id`. `list_microscopes` reads
the references for that notebook/cell. `open_microscope` takes the same scope and
ID; `close_microscope` takes the notebook path. `get_active_context` reports the
active microscope and whether its content has loaded.

Cells with microscopes have a top-right **Microscopes** dropdown. Select a title
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
full binding against notebook metadata, not just the short filename.

The protocol permits at most 16 references per cell and titles of 1–128 UTF-8
bytes without control characters. Existing notebook, metadata, response and
workspace bounds still apply. Unknown schema versions/fields are rejected. The
shell document is bounded to 4 KiB and cannot carry scripts or executable code.

Rust's `notebook-protocol::microscope` owns the schema and derivation; core/runtime
own validated transitions. Both egui and WebMCP use the same command gateway for
`create_microscope`, `delete_microscope`, and `read_microscope`. WASM does no I/O.
Browser IndexedDB commits metadata and artifact in one two-store transaction.
The native gateway accesses both files through Jupyter Contents, not host paths.

## Failure and lifecycle boundaries

Jupyter Contents has no multi-file transaction. The native gateway serializes
workspace file operations, writes/deletes the sidecar first, then saves notebook
metadata. If the save acknowledgement fails, it reads back the notebook. A matching
saved document counts as success. A confirmed failed create is compensated by
removing the new sidecar; a failed delete restores its sidecar. Failed compensation
or a crash can still leave an orphan/missing file: this is not crash-atomic storage.
Errors do not claim success; refresh and inspect before retrying. A missing file
has an actionable load error and can be removed with the human delete action.
Never automatically delete files with an unverified ownership binding.

Ordinary cell mutations cannot forge/copy microscope references or delete a cell
that still owns them. Notebook rename is also blocked while references exist;
delete microscopes first. Automatic rename/copy/export bundling, orphan recovery,
content editing, microscope navigation persistence across reload, and concurrent
external Jupyter editors are not implemented in this step. Preserve sidecars when
moving a workspace; do not copy an attached notebook alone and expect content to
follow it.

## Verification

Protocol tests cover identity, metadata preservation and rejected references.
`tests/browser-kernel/microscope.spec.ts` covers real WASM, IndexedDB, registered
WebMCP handlers, the egui shell/dropdown, human deletion and reload persistence.
The Rust native smoke scenario checks real Jupyter sidecars, metadata, idempotency
and observer rejection. `tests/browser/follow.spec.ts` checks microscope following
and independent observer navigation against the real gateway.
