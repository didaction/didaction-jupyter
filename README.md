# didaction Jupyter environment

A standalone, local-first experimental notebook runtime with a real egui
frontend compiled to WebAssembly, a real Jupyter/IPython backend, Block's pinned
MCP bridge, and browser WebMCP tools that share one validated command path.

> **Security warning:** executing a notebook executes arbitrary code with the
> privileges of the Jupyter process. This project is for trusted,
> single-user local development. It is not a sandbox, is not hardened for remote
> or multi-user deployment, and must not be exposed beyond loopback.

## Architecture and trust boundaries

```text
egui action ─┐
             ├─ browser CommandGateway ─ WASM validation ─ typed command ─┐
WebMCP tool ─┘                                                            │
                                                                          ▼
browser (no credentials) ─ same-origin /api/v1 ─ local gateway (credentials)
                                               └─ stateful MCP session
                                                  └─ mcp-jupyter 2.0.2
                                                     └─ Jupyter REST/kernel
                                                                          │
egui state ◀─ WASM reconciliation ◀─ bounded protocol snapshot ◀──────────┘
```

There is one notebook command path. egui emits typed commands; WebMCP constructs
the same bounded variants; both call `CommandGateway.execute`. Rust/WASM validates
and reconciles deterministic state but deliberately performs no fetch,
WebSocket, MCP, filesystem, process, or Jupyter operation. TypeScript owns
browser APIs. The gateway owns credentials, MCP initialization/session state,
exact tool selection, timeouts, limits, path confinement, and normalization.

The MCP mapping is explicit:

| Internal command        | Pinned MCP tool         | Supported profile                                |
| ----------------------- | ----------------------- | ------------------------------------------------ |
| setup/open              | `setup_notebook`        | relative notebook path + server-side Jupyter URL |
| query/reconnect refresh | `query_notebook`        | `query_type=view_source`                         |
| insert/edit/delete      | `modify_notebook_cells` | typed code/Markdown mutation; `execute=false`    |
| move/type conversion    | `modify_notebook_cells` | bounded query + delete/reinsert sequence         |
| execute cell            | `execute_notebook_code` | `execution_type=execute_cell`                    |

Kernel interrupt/restart, direct code execution, and close are typed but return
stable `unsupported_operation`/`execution_rejected` errors because
`mcp-jupyter 2.0.2` does not expose safe compatible operations for them. Cell
move and type conversion are isolated adapter sequences over the discovered
query/delete/add operations; no arbitrary MCP forwarding is introduced. Package
installation is always rejected.

## Install

Prerequisites: Rust 1.96 with `wasm32-unknown-unknown`, Python 3.12 through uv,
Node 26, pnpm 10.25, and a Chromium browser for browser tests.

```bash
rustup target add wasm32-unknown-unknown
uv sync --python 3.12
pnpm install
pnpm exec playwright install chromium
pnpm run build:wasm
```

Dependencies are pinned in `Cargo.lock`, `uv.lock`, and `pnpm-lock.yaml`.
`mcp-jupyter==2.0.2` also requires the explicit
`jupyter-kernel-client==0.8.0` compatibility pin: the upstream lower-bound-only
declaration otherwise selects 1.x, which removed the imported `KernelClient`.

## Start without Docker

```bash
scripts/dev.sh
```

Open <http://127.0.0.1:5173>. The script generates a development Jupyter token,
keeps it in process environment, starts JupyterLab + collaboration + IPython,
starts stateful mcp-jupyter at `http://127.0.0.1:8090/mcp/`, starts the gateway
at port 8080, and starts Vite. It never prints or sends the token to JavaScript.

To use another installed kernelspec, list it with `uv run jupyter kernelspec
list`, then provide its name in the setup command/UI host configuration. IPython
`python3` is the acceptance kernel.

## Start with Docker

```bash
export DIDACTION_JUPYTER_TOKEN="$(openssl rand -hex 24)"
docker compose up --build
pnpm run build:wasm
pnpm run dev
```

Compose publishes Jupyter, MCP, and gateway only on `127.0.0.1`. The frontend
remains a local host process so browser iteration keeps the exact WASM artifact.

## End-to-end demo and checks

With `scripts/dev.sh` running in one terminal:

```bash
scripts/smoke.sh
pnpm run test:browser
scripts/check.sh
```

The smoke test opens `acceptance.ipynb`, inserts `value = 40 + 2`, executes it,
inserts and executes `value`, queries through MCP, and requires the normalized
snapshot to contain `42`. Browser restart restores state by setup/querying the
persisted notebook and its live Jupyter session. A transport disconnect produces
a retryable `disconnected` result; reconnect performs a full query and revision
reconciliation without replaying mutations.

`scripts/check.sh` runs Rust formatting, clippy, unit tests, wasm32 checking,
frontend formatting/typechecking/tests/build, Python formatting/lint/typecheck/
tests, live MCP discovery, Playwright browser tests, and the real smoke.

## WebMCP

The browser feature-detects `navigator.modelContext`. Without it the notebook is
fully usable and reports `WebMCP unavailable`. When present, it registers bounded
`notebook_query`, `notebook_modify_cells`, `notebook_execute`, and
`notebook_setup` tools. Handlers validate through Rust/WASM, dispatch through the
same gateway as egui, await the committed Jupyter result, reconcile, and return a
bounded public snapshot. No token, connection detail, raw notebook file,
filesystem method, arbitrary MCP name, package installer, or shell/process API is
exposed.

## Safely upgrading mcp-jupyter

1. Change the exact `mcp-jupyter` pin on a dedicated branch; do not loosen it.
2. Review the upstream release/source and its transitive kernel-client API.
3. Start Jupyter and the candidate server in stateful HTTP mode.
4. Run `uv run python scripts/discover_mcp.py`; confirm initialization, the
   `/mcp/` endpoint, protocol version, and `tools/list` output.
5. Intentionally update `tests/fixtures/...tools.json` after reviewing every
   property, required field, output schema, and unsafe new operation.
6. Update only `McpNotebookTransport.map_command` and normalization—never leak a
   raw schema into browser or egui code.
7. Run gateway compatibility/mapping/security tests, full browser tests, and the
   real `42` smoke. Startup must remain fail-closed on an incompatible profile.

## Current limitations

- The UI targets original Jupyter Notebook ergonomics, not JupyterLab parity.
- `mcp-jupyter 2.0.2` has positional mutation/execution but no atomic move tool.
  Moving or converting a cell preserves its type and source through a bounded
  delete/reinsert sequence, but existing execution count and outputs are not
  retained. Interrupt, restart, and close still fail explicitly.
- WebMCP is an experimental browser API and is unavailable in most browsers.
- Rich output support is bounded to text/stream/error and a basic text rendering
  of rich MIME data; interactive widgets and binary images are not implemented.
- The gateway currently serves one isolated local notebook session per process.
- RTC synchronization is supplied by Jupyter collaboration, while the egui host
  reconciles on committed commands, reconnect, and restart-time full refresh;
  no high-frequency background file watcher is included.

## Manual review

Begin with:

1. `validate_command` / `validate_snapshot` in
   `crates/notebook-protocol/src/lib.rs`.
2. `NotebookState::prepare` / `apply_result` in
   `crates/notebook-core/src/lib.rs`.
3. `CommandGateway.execute` and `installWebMcp` under `web/src/`.
4. `McpNotebookTransport.discover`, `map_command`, and `execute` in
   `services/gateway/app/mcp_adapter.py`.
5. `command_endpoint` in `services/gateway/app/main.py`.
