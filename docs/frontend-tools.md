# Frontend notebook tools

The frontend tool catalog is inspired by the cell operations in
[Datalayer's Jupyter MCP Server](https://jupyter-mcp-server.datalayer.tech/mcp/).
This is a bounded, single-notebook implementation, not a drop-in copy of its
schemas or a connection to its hosted server. No Datalayer dependency is installed.

`NotebookToolInvoker.listTools()` and `callTool(name, arguments)` are the
transport-independent interface. Results contain MCP-style text content,
structuredContent and isError. `webmcp.ts` only registers this catalog with
`navigator.modelContext`. Additional adapters can invoke the same interface;
there is currently no stdio/HTTP MCP listener or JSON-RPC session server.
WebMCP-unavailable browsers remain fully usable by humans.

## Tools

- read_notebook, read_cell
- insert_cell, overwrite_cell_source, edit_cell_source
- move_cell, delete_cell, clear_cell_output
- execute_cell, insert_execute_code_cell
- interrupt_kernel, restart_notebook

Read the advertised JSON Schemas for exact arguments. Cells are addressed by
stable `cell_id`, not positional IDs; only insertion/movement take a zero-based
`index`. Source is limited to 64,000 UTF-8 bytes at this interface, execution to
120 seconds, input to 200 KB, and each serialized answer payload to 200 KB.
Oversized answers return a bounded error (an earlier mutation may be committed).
`edit_cell_source` requires a unique literal match unless replace_all is true.

All commands pass through the same Rust/WASM validation, CommandGateway and
direct Jupyter transport as egui. Tool transactions share egui's serial queue,
including read/modify and insert/execute sequences. They refresh committed state
before resolving IDs. Tool results and intermediate execution snapshots are
validated in WASM and reconciled into the mounted egui app without a reload.
Unsaved local edits block tools; cell editing is disabled during tool transactions.
Insertion followed by failed execution is explicitly reported as a partial commit.
No tool call is automatically retried after an ambiguous network failure.

Interrupt is deliberately out-of-band, with an independent WASM validator using
the same CommandGateway class; otherwise it could not stop a queued execution.
It does not advance that execution's local validator revision. The execution's
final result reconciles the notebook afterward.

## Security and limitations

The notebook, workspace and kernel remain startup configuration. No browser tool
can switch servers, supply credentials, browse files, launch sandboxes, or forward
arbitrary MCP/Jupyter calls. Notebook outputs and source are intentional public
tool data; never place secrets in them. Read results omit kernel/session metadata.
Execution annotations mark unsafe, potentially external side effects. Explicit
shell/package magics are rejected by the tools, but arbitrary Python is still
arbitrary code: this filter is not a sandbox or an exfiltration defense.

Detached execute*code is not advertised because the current backend does not
implement it. Use insert_execute_code_cell for inspectable, persisted execution.
Multi-notebook selection, Datalayer prompts, resources, cloud and file tools are
not included. Tool names replace the earlier four notebook*\* WebMCP handlers.
Browser WebMCP support is experimental; automated browser tests inject a
modelContext registration shim and invoke its real handlers against real WASM,
gateway and ipykernel. This does not claim native browser-agent support everywhere.

## Verification and review

Run `pnpm test`, `pnpm typecheck`, `scripts/check.sh`, and, after building the
gateway image, `bash scripts/container-check.sh`. The latter uses an isolated
notebook folder and verifies tool edits, execution, reload, and deletion through
real Jupyter. Start review at `web/src/notebook-tools.ts`, `web/src/webmcp.ts`,
`web/src/command-gateway.ts`, and `MountedNotebook` in notebook-wasm.
