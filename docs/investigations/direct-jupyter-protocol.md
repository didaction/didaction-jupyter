# Direct Jupyter protocol investigation

## Decision

This repository can use Jupyter Server directly, and doing so would remove the
current `mcp-jupyter` limitations around empty cells, cell moves, cell type
conversion, durable cell IDs, interrupt, and restart. The recommended design is
to add a `JupyterNotebookTransport` behind the **existing local gateway API**,
not to connect Rust/WASM or browser JavaScript directly to Jupyter.

Keep `McpNotebookTransport` as a pinned, compatibility-tested adapter for the
required MCP bridge. Select the transport server-side (and test both), while
preserving the single command path:

```text
egui action ─┐
             ├─ CommandGateway ─ WASM validation ─ /api/v1/commands ─┐
WebMCP tool ─┘                                                       │
                                ┌─ JupyterNotebookTransport (direct) ┤
                                └─ McpNotebookTransport (MCP bridge) ┘
                                      ↓
                            bounded normalized result
                                      ↓
                          WASM reconciliation → egui
```

This is consistent with Jupyter's own architecture: Notebook 7 uses JupyterLab
frontend components and Jupyter Server as its backend
([Jupyter Notebook repository](https://github.com/jupyter/notebook#notebook-v7)),
and `@jupyterlab/services` is the official JavaScript client for the Jupyter
services REST APIs
([services overview](https://github.com/jupyterlab/jupyterlab/blob/main/packages/services/README.md)).
The project should learn from those clients, but should not add
`@jupyterlab/services` to the browser: that would put the Jupyter token and a
kernel WebSocket in the browser, contrary to this repository's security
invariants.

## Current repository fit

The current seams are already close to what is needed:

- `web/src/command-gateway.ts` validates every human and WebMCP command through
  WASM, selects a typed `NotebookTransport` method, and reconciles the result.
- `web/src/mcp-client.ts` is named after MCP but actually calls only the local
  same-origin `/api/v1/commands` endpoint. Rename it to something neutral when
  implementing this work; the browser transport does not need to know which
  server-side adapter ran.
- `services/gateway/app/main.py` currently instantiates
  `McpNotebookTransport`, checks an in-memory revision, executes, then queries a
  full snapshot.
- `services/gateway/app/mcp_adapter.py` contains the important external-schema
  isolation, but mcp-jupyter's positional identities and single-cell tools force
  delete/reinsert sequences for move and type conversion. Those are not atomic
  and can lose metadata, outputs, and stable identity.
- `notebook-protocol` and `notebook-core` should remain the authority for
  command validation, optimistic revisions, idempotency, and reconciliation.
  A direct adapter is still a transport adapter, not a second notebook model.

The direct adapter therefore belongs beside `mcp_adapter.py`; it should consume
the same validated `Command` and emit the same bounded `CommandResult` snapshot.
No egui, WebMCP, protocol, or core command variant needs an MCP- or
Jupyter-specific escape hatch.

## What “the Jupyter protocol” consists of

There is no single notebook mutation protocol. A regular frontend composes the
following services.

### Notebook document: Contents REST API

Use these endpoints, relative to the configured Jupyter Server base URL:

| Purpose                     | Request                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Open/refresh notebook       | `GET /api/contents/{path}?type=notebook&content=1&hash=1`                                                                |
| Save/create notebook        | `PUT /api/contents/{path}` with `type: "notebook"`, `format: "json"`, and complete nbformat JSON in `content`            |
| Create an untitled notebook | `POST /api/contents/{directory}` with `type: "notebook"` (optional; this product normally has an explicit confined path) |
| Checkpoints                 | `GET`/`POST /api/contents/{path}/checkpoints`, restore with `POST /api/contents/{path}/checkpoints/{id}`                 |

The official REST specification defines notebook reads, optional content hashes,
`Last-Modified`, and full-document saves
([Jupyter Server REST API](https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html#get--api-contents-path)).
The save body is a whole content model, not a per-cell patch
([same specification](https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html#put--api-contents-path)).

Direct cell operations are consequently a bounded read/modify/save transaction
inside the adapter:

1. read and validate the notebook as nbformat;
2. compare the adapter's last observed content hash/revision;
3. apply exactly one validated internal mutation to a copy;
4. validate the resulting nbformat and all project bounds;
5. save the full notebook;
6. re-read (or validate the returned content model) and normalize the committed
   snapshot.

Use nbformat 4.5 cell `id` values as protocol cell identities rather than
`position-N`. The official schema requires IDs to be 1–64 characters drawn
from alphanumerics, `-`, and `_`, and defines code cells' source, metadata,
outputs, and execution count
([nbformat 4.5 schema](https://github.com/jupyter/nbformat/blob/main/nbformat/v4/nbformat.v4.5.schema.json)).
Generate an ID only for a new cell, preserve it across edit/move/type conversion,
and reject duplicate IDs.

This immediately supports insert above/below, edit, delete, move, code/Markdown/
raw conversion, clear output, and multi-cell atomic mutations at the adapter's
model level. A save is still not a compare-and-swap at the Jupyter Server API
level; see concurrency below.

### Kernel persistence: Sessions REST API

A session maps a notebook path to a kernel. That is the mechanism JupyterLab
uses to reconnect a refreshed frontend to the same live kernel
([JupyterLab services session model](https://github.com/jupyterlab/jupyterlab/blob/main/packages/services/README.md#sessions)).

| Purpose                        | Request                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Discover reusable session      | `GET /api/sessions`, match exact confined `path` and notebook `type`                             |
| Create/reuse session           | `POST /api/sessions` with `path`, `name`, `type: "notebook"`, and `kernel: {"name": kernelspec}` |
| Inspect session                | `GET /api/sessions/{session_id}`                                                                 |
| Change session/path/kernel     | `PATCH /api/sessions/{session_id}`                                                               |
| Close and terminate its kernel | `DELETE /api/sessions/{session_id}`                                                              |

These operations and their response models are specified by Jupyter Server
([Sessions REST API](https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html#post--api-sessions)).
On setup/reconnect, list sessions before creating one and keep the server-side
session ID in gateway memory only. On browser restart, rediscover by notebook
path. Disposing a gateway connection must not implicitly delete the session;
`close` and “shut down kernel” need separate semantics.

Available kernels come from `GET /api/kernelspecs`. If a session is not used,
`POST /api/kernels` can start a kernel, but sessions are preferable because they
associate lifecycle with the notebook path. Jupyter Server also exposes kernel
inspect/delete, `POST /api/kernels/{kernel_id}/interrupt`, and
`POST /api/kernels/{kernel_id}/restart`
([Kernels REST API](https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html#post--api-kernels-kernel_id-interrupt)).

### Execution: kernel channels WebSocket

Connect from the gateway to:

```text
ws://127.0.0.1:8888/api/kernels/{kernel_id}/channels?session_id={client_uuid}
```

The server multiplexes `shell`, `iopub`, `stdin`, and `control` kernel channels
onto this one WebSocket. The official WebSocket specification defines both the
required default framing and optional `v1.kernel.websocket.jupyter.org` binary
subprotocol
([Jupyter Server WebSocket protocol](https://github.com/jupyter-server/jupyter_server/blob/main/docs/source/developers/websocket-protocols.rst)).
Implement the required default framing first and explicitly negotiate/test any
binary subprotocol later.

For a cell run, send an `execute_request` on `shell` with a fresh message ID and
content equivalent to:

```json
{
  "code": "<validated bounded cell source>",
  "silent": false,
  "store_history": true,
  "user_expressions": {},
  "allow_stdin": false,
  "stop_on_error": true
}
```

Correlate **every** reply and IOPub side effect using
`message.parent_header.msg_id == request.header.msg_id`. The Jupyter messaging
spec says the parent header routes outputs to the request/cell, and describes
the normal sequence as IOPub `busy`, output messages, shell `execute_reply`, and
IOPub `idle`
([Jupyter messaging specification](https://jupyter-client.readthedocs.io/en/stable/messaging.html#parent-header)).
Completion requires both the correlated shell reply and correlated idle status;
the spec notes that asynchronous output can arrive out of order, so keep a
short, bounded post-idle drain policy and never attach unparented/foreign output
to the active cell.

Normalize only these bounded output families into the internal protocol:

- `stream` → stdout/stderr text;
- `execute_result` → execution count plus an allowlisted MIME bundle;
- `display_data` and `update_display_data` → allowlisted bounded rich output,
  keyed by `display_id` only within the connection;
- `error` → bounded `ename`, `evalue`, and traceback;
- `clear_output` → immediate or deferred clear according to `wait`;
- `execute_input`/`execute_reply` → execution count and terminal status.

JupyterLab's message types are a useful executable reference for the channel and
output shapes
([`packages/services/src/kernel/messages.ts`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/services/src/kernel/messages.ts)).
Reject `input_request` because this product sends `allow_stdin: false`; do not
add arbitrary comm forwarding or widget execution in the first phase.

After a successful execution, merge bounded outputs and execution count into the
matching cell by stable cell ID and save the notebook through Contents REST.
Treat “kernel executed but notebook save failed” as a specific retryable partial
commit error that forces a refresh; it cannot honestly be reported as an atomic
failure because kernel state has already changed.

## Concurrency and collaboration risks

The plain Contents API is a whole-document save API, not a collaborative edit
protocol and not a transactional compare-and-swap service. `hash` and
`last_modified` are observations; the published PUT contract has no `If-Match`
precondition. Two independent frontends can therefore both read revision N and
the later save can overwrite the earlier save. JupyterLab itself exposes a
last-modified tolerance setting for detecting disk changes
([document manager settings](https://github.com/jupyterlab/jupyterlab/blob/main/packages/docmanager-extension/schema/plugin.json)),
which is conflict detection rather than atomic prevention.

For this local, single-user v1:

- serialize all commands per notebook in the gateway;
- hash canonical full nbformat content and map it to the internal monotonic
  revision;
- re-read immediately before every mutation and reject if the observed hash is
  not the command's expected base;
- re-read after save and reconcile the committed snapshot;
- on disconnect or ambiguity, never retry a mutation blindly—query, compare the
  stable cell ID/content, then either recognize the idempotent commit or return
  `refresh_required`;
- document that simultaneous edits from JupyterLab/Notebook are unsupported in
  this mode.

Do **not** attempt to invent operational transforms for multi-client use.
Jupyter's supported collaboration stack is `jupyter-collaboration` plus Yjs
shared documents; its server persists document changes and session continuity
in a YStore
([official collaboration configuration](https://github.com/jupyterlab/jupyter-collaboration/blob/main/docs/source/configuration.md)).
Supporting that correctly would require a separate, version-pinned collaborative
document transport and protocol fixtures. It is a later milestone, not a small
extension of Contents PUT.

## Security implications

Direct Jupyter access should remain server-to-server inside the local gateway.
Jupyter's security documentation states plainly that access to Jupyter Server
means arbitrary code execution and that token authentication is enabled by
default
([Jupyter Server security](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)).

Required boundaries:

- keep the Jupyter token only in the gateway process environment and use an
  `Authorization: token …` header for REST and authenticated WebSocket setup;
- never put a token in a browser URL, DOM, storage, error, command result, or
  routine log;
- retain loopback binding and same-origin browser access to the gateway;
- keep Jupyter's root directory dedicated and also run every requested notebook
  path through `Settings.confined_path`; reject absolute paths, traversal,
  encoded traversal, symlink escapes, and non-`.ipynb` paths;
- leave XSRF and Origin checks enabled; do not solve proxy problems by using
  `allow_origin='*'` or disabling XSRF;
- bound REST bodies, WebSocket frames, cell source, MIME data, output count,
  aggregate output, execution time, and post-idle drain time;
- allowlist display MIME types. Render HTML/SVG only through a sanitizer and
  never execute output JavaScript. Start with text/plain, bounded images, and
  sanitized Markdown/HTML;
- set `allow_stdin: false`, reject comms/widget forwarding initially, and never
  expose terminal endpoints, arbitrary paths, kernels by ID, or generic Jupyter
  requests to WebMCP;
- cancel timed-out executions with the kernel interrupt REST endpoint, then
  return a typed timeout. A timeout is not proof that no side effect occurred;
  force query/reconciliation before another mutation.

The adapter should log only command ID, internal command variant, duration,
bounded status/error code, and retry count. It must redact Authorization,
cookies, WebSocket query strings, source, notebook JSON, outputs, paths if they
can be sensitive, and session/kernel IDs.

## Frontend behavior to replicate in egui

Notebook 7 uses JupyterLab's notebook components, so the current JupyterLab
sources are the right implementation reference rather than the maintenance-only
Classic Notebook v6 frontend
([Notebook repository](https://github.com/jupyter/notebook#maintained-versions)).
Copy interaction semantics and state transitions, not its TypeScript widget
architecture.

### Source map for manual study

| Official source                                                                                                                                                                                                                                                 | What to mirror in egui                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/notebook/src/actions.tsx`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/notebook/src/actions.tsx)                                                                                                                                     | `NotebookActions` and its `insertAbove`, `insertBelow`, delete, move, change type, run, run-and-advance, run-and-insert, and run-all behavior. Insertion activates the new cell and clears multi-selection; moves preserve running execution futures. |
| [`packages/notebook-extension/src/index.ts`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/notebook-extension/src/index.ts)                                                                                                                       | Stable command vocabulary and enable/visible rules for insert, move, cut/copy/paste, run, interrupt, restart, clear outputs, mode changes, and kernel selection.                                                                                      |
| [`packages/notebook-extension/schema/tracker.json`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/notebook-extension/schema/tracker.json)                                                                                                         | Canonical shortcut bindings and command-mode/edit-mode selectors.                                                                                                                                                                                     |
| [`packages/notebook/src/widget.ts`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/notebook/src/widget.ts)                                                                                                                                         | Active cell, selection, command/edit mode, focus, scrolling, viewport, and ordered cell widget behavior.                                                                                                                                              |
| [`packages/notebook/src/cellexecutor.ts`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/notebook/src/cellexecutor.ts)                                                                                                                             | Run preconditions, output clearing/timing, kernel future ownership, execution state, and reply/error handling.                                                                                                                                        |
| [`packages/apputils/src/sessioncontext.tsx`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/apputils/src/sessioncontext.tsx)                                                                                                                       | Reuse a path-associated session, kernel preferences, restart/change/shutdown lifecycle, and status propagation.                                                                                                                                       |
| [`packages/services/src/kernel/default.ts`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/services/src/kernel/default.ts) and [`future.ts`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/services/src/kernel/future.ts)            | WebSocket reconnect, request futures, `msg_id` correlation, reply/IOPub completion, and disposal. Use as a behavioral reference; the gateway implementation will be Python.                                                                           |
| [`packages/services/src/contents/index.ts`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/services/src/contents/index.ts) and [`session/default.ts`](https://github.com/jupyterlab/jupyterlab/blob/main/packages/services/src/session/default.ts) | Concrete URL construction, content/session model validation, and lifecycle semantics.                                                                                                                                                                 |

### MVP ergonomics contract

Jupyter's own user documentation identifies the defining notebook interaction as
a modal UI: `Enter` enters edit mode, `Esc` enters command mode, and command mode
maps keys to cell actions
([Notebook Basics](https://jupyter-notebook.readthedocs.io/en/stable/examples/Notebook/Notebook%20Basics.html#keyboard-navigation)).
Implement this explicitly in egui rather than letting editor focus implicitly
define notebook state.

**Command mode**

- Blue/strong active-cell outline; editor does not consume printable keys.
- `Enter`: edit active cell. `Esc`: remain in command mode and clear transient
  editor selection.
- `Up`/`K`, `Down`/`J`: move active cell; `Shift` extends cell selection.
- `A`/`B`: insert code cell above/below, select it, remain in command mode.
- `X`, `C`, `V`: cut/copy/paste selected cells using an internal bounded cell
  clipboard (not raw notebook JSON); `D D`: delete; `Z`: undo last structural
  action.
- `Y`, `M`, `R`: code, Markdown, raw cell; `1`–`6`: Markdown heading shortcut.
- `Ctrl/Cmd+Enter`: run in place; `Shift+Enter`: run and select next (insert a
  code cell if at end); `Alt+Enter`: run and insert below in edit mode.
- `I I`: interrupt; `0 0`: restart, with explicit confirmation for restart.
- `S`/`Ctrl/Cmd+S`: save/flush pending edits and show synchronized status.

**Edit mode**

- Green/accent editor outline, visible caret, language-aware code editor, and
  normal text-editing shortcuts.
- `Esc` returns to command mode without losing edits.
- `Ctrl/Cmd+Enter`, `Shift+Enter`, and `Alt+Enter` retain the execution meanings
  above; prevent the editor from inserting a newline for those chords.
- Up/down remains editor navigation except at well-defined boundary behavior;
  do not unexpectedly move active cells while a text selection exists.

**Cell and notebook state**

- Use stable cell IDs for widget keys, selection, pending executions, output
  routing, and reconciliation; index is presentation order only.
- Preserve draft source locally while an update is pending. Show an explicit
  dirty marker, per-cell running spinner, `In [ ]` / `In [*]` / `In [n]`
  prompt, kernel status, connection state, and last actionable error.
- Treat structural actions as local optimistic commands but disable conflicting
  actions on the same cells until committed. Execution should snapshot the exact
  committed source it sends.
- Markdown has edit and rendered states; code remains code-first. Rich outputs
  are subordinate to the editor and bounded.
- Run-all is a sequence of typed execute-cell commands in visible order, stops
  on error by default, and remains observable/cancellable; it is not one
  arbitrary-code escape hatch.

## Recommended implementation

### Adapter decomposition

Avoid a single large transport class. Use these internal gateway modules:

```text
jupyter_transport.py       typed command orchestration; no HTTP details
jupyter_contents.py        confined Contents REST, nbformat validation/save
jupyter_sessions.py        kernelspec/session/kernel lifecycle REST
jupyter_channels.py        WebSocket framing, msg_id futures, reconnect
jupyter_outputs.py         bounded allowlisted message → protocol output
jupyter_mutations.py       pure copy-on-write cell mutation by stable ID
```

`JupyterNotebookTransport.execute(command, notebook_path)` should be the only
entry point exposed to `main.py`. A per-notebook async lock serializes mutations;
a per-kernel connection object owns one WebSocket and a map from request message
ID to bounded execution future. All raw Jupyter models end at this module
boundary.

Make transport selection an explicit startup setting such as
`DIDACTION_NOTEBOOK_TRANSPORT=mcp|jupyter`, defaulting to `mcp` until direct mode
passes the real acceptance suite. `/readyz` should report the adapter kind and
protocol compatibility profile but no URL, token, session, kernel, or notebook
details.

### Phased plan and verification gates

1. **Freeze behavior and add neutral interfaces.** Rename the browser-side
   transport file/class to `GatewayNotebookTransport`; define a Python transport
   protocol; inject the adapter into the FastAPI app. Run all existing MCP,
   browser, and smoke tests unchanged.
2. **Contents and stable IDs.** Pin `jupyter_server` and `nbformat`; implement
   confined GET/PUT, canonical revision hashes, nbformat validation, and pure
   insert/edit/delete/move/type/clear-output mutations. Unit-test old notebooks
   without IDs, duplicate IDs, every cell type, metadata/output preservation,
   traversal/symlink escapes, stale hashes, response limits, and save conflicts.
3. **Sessions and lifecycle.** Implement kernelspec discovery, path-based session
   reuse, create, reconnect, close, interrupt, and restart. Integration-test
   browser restart preserving a real IPython variable and distinguish dispose
   from kernel shutdown.
4. **Kernel channels.** Implement default WebSocket framing and correlated
   execute futures, then stream/error/display normalization and notebook save.
   Test interleaved executions, foreign IOPub messages, clear-output wait,
   update-display, missing reply, idle-before-reply, late output, oversized
   frames, timeout/interrupt, socket loss, duplicate frames, and restart while
   executing against real `ipykernel`.
5. **egui parity.** Add explicit command/edit mode, stable-ID focus, selection,
   shortcut state machine (including two-key chords), structural undo, run-and-
   advance/insert, raw cells, clear output, and save status. Browser tests must
   drive both mouse toolbar and keyboard paths.
6. **Cross-path acceptance.** Run the existing human/WebMCP convergence scenario
   once with MCP mode and once with direct mode. Assert both still enter
   `CommandGateway.execute`, produce the same protocol snapshot, preserve kernel
   state across frontend restart, and recover from disconnect without duplicate
   mutation.
7. **Optional collaboration spike.** Only after direct single-writer mode is
   complete, investigate the pinned `jupyter-collaboration`/Yjs document
   protocol. Do not advertise multi-client editing until a real JupyterLab and
   egui client can concurrently edit without lost updates.

### Acceptance recommendation

Direct mode is ready to become the local default only when all of the following
pass against a real pinned Jupyter Server and `ipykernel`:

- create/open, render, add above/below, edit, delete, move, type conversion, and
  stable IDs survive disk reload;
- execute `value = 40 + 2`, then `value`, reconcile and persist `42`;
- interrupt and restart are observable and bounded;
- browser reload reconnects to the path-associated session and retains `value`;
- injected disconnect after a committed save is recognized by content/ID and
  does not duplicate a mutation;
- stale external file changes yield a typed refresh/conflict error rather than
  overwrite;
- egui and WebMCP changes remain mutually visible through the same command
  gateway;
- tokens, code, content, outputs, paths, cookies, session IDs, and kernel IDs do
  not appear in DOM, storage, console, tool results, or routine logs.

## Bottom line

Use Jupyter Server directly **inside the gateway** for the primary local
notebook runtime, while retaining the pinned MCP adapter as a separately tested
bridge. This gives egui the primitives of a regular Jupyter frontend without
breaking the product's strongest architectural property: one validated command
and reconciliation path for humans and WebMCP.
