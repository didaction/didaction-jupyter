# Frontend notebook tools

The frontend tool catalog is inspired by the cell operations in
[Datalayer's Jupyter MCP Server](https://jupyter-mcp-server.datalayer.tech/mcp/).
This is a bounded, workspace-scoped implementation, not a drop-in copy of its
schemas or a connection to its hosted server. No Datalayer dependency is installed.

`NotebookToolInvoker.listTools()` and `callTool(name, arguments)` are the
transport-independent interface. Results contain MCP-style text content,
structuredContent and isError. `webmcp.ts` only registers this catalog with
`document.modelContext`, falling back to `navigator.modelContext`. Registration
is awaited and an abort signal cleans up document-based registrations.
Additional adapters can invoke the same interface;
there is currently no stdio/HTTP MCP listener or JSON-RPC session server.
WebMCP-unavailable browsers remain fully usable by humans.

## Tools

- get_active_context(): one local call returning a canonical `context` with
  `view` (`notebook`, `microscope`, or `playground`), `notebook`, nullable
  `selection`, `scroll_fraction`, nullable `microscope`, and nullable
  `playground`. A selection contains its zero-based cell index, edit/command mode,
  live `draft` source/dirty flag, and nullable queued/running execution source.
  Playground context separately reports its owning notebook cell/microscope,
  walkthrough step, role, live draft, executing source/status/count, and latest
  bounded outputs. Null context means no active view. This is mounted UI state,
  not a queued kernel read, so unsubmitted editor text is visible.
- read_playground(notebook_path): queue-independent reconciled temporary snapshot;
  it can observe intermediate outputs while execution continues. It intentionally
  does not duplicate mounted draft/executing-source fields from active context.
- list_notebooks(directory): confined folders/notebooks; empty string means root
- list_open_notebooks(): this frontend workspace's open notebooks and active view
- open_notebook(notebook_path): open an existing notebook and select its egui view
- close_notebook(notebook_path): release its frontend state, preserving file and kernel
- read_notebook, read_cell
- insert_cell, overwrite_cell_source, edit_cell_source
- set_markdown_code_group(cell_id, grouped): persistently join a code cell to
  the immediately preceding Markdown cell in one shared visible boundary. The
  code cell owns the versioned `didaction_markdown_group` metadata and remains
  the combined unit's selected identity in `get_active_context`; the human Cell
  menu can group or ungroup the same pair.
- move_cell, delete_cell, clear_cell_output
- execute_cell, insert_execute_code_cell
- interrupt_kernel, restart_notebook
- set_cell_visibility(cell_id, collapsed)
- set_output_visibility(cell_id, mode): expanded, windowed, collapsed
- capture_cell(cell_id): PNG image content plus dimensions and clipped flag

Read the advertised JSON Schemas for exact arguments. Cells are addressed by
required `notebook_path` (workspace-relative, including `.ipynb`) and stable
`cell_id`, not positional IDs; only insertion/movement take a zero-based
`index`. Source is limited to 64,000 UTF-8 bytes at this interface, execution to
120 seconds, input to 200 KB, and each serialized answer payload to 200 KB.
Oversized answers return a bounded error (an earlier mutation may be committed).
`edit_cell_source` requires a unique literal match unless replace_all is true.

Notebook data commands pass through the same Rust/WASM validation, CommandGateway and
direct Jupyter transport as egui. Tool transactions share egui's serial queue,
including read/modify and insert/execute sequences. They refresh committed state
before resolving IDs. Tool results and intermediate execution snapshots are
validated in WASM and reconciled into the mounted egui app without a reload.
Unsaved local edits block tools; cell editing is disabled during tool transactions.
Insertion followed by failed execution is explicitly reported as a partial commit.
No tool call is automatically retried after an ambiguous network failure.

View tools share the frontend serial queue but do not contact Jupyter. They use
the mounted WASM view API, validate stable cell IDs there, and change the same
egui visibility state as human controls. They preserve sources, outputs, notebook
revisions and pending edits. Visibility is local to the tab and does not filter
read results. Capture scrolls to the target without expanding it, reads the
actual egui framebuffer, crops to the cell's visible region (excluding adjacent
cells/toolbars), and returns PNG image content. It is not an HTML reconstruction.
Tall cells are explicitly marked clipped; capture respects collapsed/windowed
output modes. Keep the tab visible while capturing. Capture is bounded to four
million pixels and two million base64 PNG characters, with a ten-second timeout.
Images reflect the current rendered state; retry if a resource is still loading.

Interrupt is deliberately out-of-band, with an independent WASM validator using
the same CommandGateway class; otherwise it could not stop a queued execution.
It does not advance that execution's local validator revision. The execution's
final result reconciles the notebook afterward.

## Security and limitations

The workspace and kernel remain startup configuration. The human Files sidebar
and tool opening use the same workspace controller. Each open notebook has its
own WASM validator, transport scope, and command queue. Cell tools never default
to the selected notebook; missing addresses and unopened notebooks are rejected.
Open/close are serialized with tool operations; unsaved edits block switching.
Up to 16 notebooks can be open in one frontend workspace. This registry is
page-local, not a census of other browser tabs or Jupyter sessions. Reload opens
the selected URL notebook; it does not restore the whole open-notebook list.
View/capture tools require selecting the addressed notebook with open_notebook.
Closing does not stop the kernel; restart_notebook explicitly resets its memory.
No browser tool can switch servers, supply credentials, browse arbitrary files, launch sandboxes, or forward
arbitrary MCP/Jupyter calls. Notebook outputs and source are intentional public
tool data; never place secrets in them. Read results omit kernel/session metadata.
Execution annotations mark unsafe, potentially external side effects. Explicit
shell/package magics are rejected by the tools, but arbitrary Python is still
arbitrary code: this filter is not a sandbox or an exfiltration defense.

Detached execute*code is not advertised because the current backend does not
implement it. Use insert_execute_code_cell for inspectable, persisted execution.
Dataset creation, Datalayer prompts, resources, cloud and arbitrary file tools are
not included. Tool names replace the earlier four notebook*\* WebMCP handlers.
Browser WebMCP support is experimental; automated browser tests inject a
modelContext registration shim and invoke its real handlers against real WASM,
gateway and ipykernel. This does not claim native browser-agent support everywhere.

## Verification and review

### Multiple clients

Execution NDJSON streams are request-local, not broadcast subscriptions. Other
tabs do not receive edits, outputs, selections, or kernel-status updates pushed
from the initiating tab. Refresh/reconnect retrieves persisted notebook state;
queries may wait behind the notebook's execution lock. Open views and selections
are page-local. This is not real-time collaborative editing.

Per-notebook locks serialize adapter work, but expected revisions are checked
before acquiring that lock. Concurrent writers can both pass the same revision
check; do not treat this as atomic conflict prevention. A shared subscription
stream, revision validation inside the mutation lock, and explicit dirty-editor
conflict handling are prerequisites for reliable multi-client synchronization.

Run `pnpm test`, `pnpm typecheck`, `scripts/check.sh`, and, after building the
gateway image, `bash scripts/container-check.sh`. The latter uses an isolated
notebook folder and verifies tool edits, execution, reload, and deletion through
real Jupyter. Start review at `web/src/notebook-tools.ts`, `web/src/webmcp.ts`,
`web/src/command-gateway.ts`, and `MountedNotebook` in notebook-wasm.
