# AGENTS.md

## Purpose

This repository is a local-development notebook runtime. It joins a real Jupyter
kernel to an egui/WebAssembly notebook UI and browser WebMCP tools through one
validated command path.

## Architecture

`notebook-protocol` owns versioned serialized contracts and hard bounds.
`notebook-core` owns deterministic state, optimistic commands, revisions, and
reconciliation. `notebook-egui` renders state and emits typed commands only.
`notebook-wasm` validates browser inputs, mounts egui, and reconciles results.
TypeScript owns browser APIs and transport. The Python gateway owns the MCP
client session, schema compatibility check, Jupyter URL, and bounded result
normalization. Block's pinned `mcp-jupyter` owns Jupyter REST/kernel operations.

Human egui and WebMCP calls both enter `web/src/command-gateway.ts`. Never add a
second mutation path or a generic MCP forwarding method.

## Invariants

- Rust/WASM never fetches, opens sockets/files, launches processes, or knows MCP
  tool names.
- The browser never receives Jupyter tokens or MCP session identifiers.
- Raw MCP data never enters egui state; normalize it to protocol snapshots.
- Reject unknown protocol versions, traversal, absolute paths, oversized data,
  stale revisions, malformed results, and unsupported operations.
- Failed deterministic transitions leave the prior state unchanged.
- Result application is idempotent by command ID and idempotency key.
- `execute_notebook_code.install_packages`, direct code execution, arbitrary MCP
  calls, and arbitrary kernel management remain unavailable.
- Jupyter, MCP, gateway, and frontend bind to loopback in non-container startup.
- `mcp-jupyter==2.0.2` and `jupyter-kernel-client==0.8.0` are a tested pair. Do
  not loosen either pin without refreshing the schema fixture and real smoke.

## Commands

- Install: `uv sync --python 3.12 && pnpm install`
- Develop: `scripts/dev.sh`
- Fast unit checks: `cargo test --workspace && pnpm test && uv run pytest -q`
- Full verification: `scripts/check.sh` (requires the local stack for discovery,
  browser, and smoke portions)
- Schema discovery: `uv run python scripts/discover_mcp.py`
- Real acceptance: `scripts/smoke.sh`
- Docker: generate/export `DIDACTION_JUPYTER_TOKEN`, then
  `docker compose up --build`

## Security boundaries

Notebook execution is arbitrary code execution as the local user/container.
This is not a sandbox or multi-user service. Keep the workspace dedicated,
credentials in process environment, ports loopback-bound, logs redacted, and
all browser-facing results bounded. Never log command bodies, cell sources,
notebook contents, outputs, tokens, authorization headers, or MCP session IDs.

## Review entry points

Start at `crates/notebook-protocol/src/lib.rs`, then
`crates/notebook-core/src/lib.rs`, `web/src/command-gateway.ts`, and
`services/gateway/app/mcp_adapter.py`. Transport/schema upgrades begin with
`tests/fixtures/mcp-jupyter-2.0.2-tools.json`.
