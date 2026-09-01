# AGENTS.md

## Purpose

This repository is a local-development notebook runtime joining a real Jupyter
kernel to an egui/WebAssembly UI and optional browser WebMCP tools through one
validated command path.

## Architecture

`notebook-protocol` owns bounded serialized contracts. `notebook-core` owns
deterministic optimistic state and reconciliation. `notebook-egui` renders state
and emits typed commands. `notebook-wasm` validates commands, mounts egui, and
reconciles results. TypeScript owns browser APIs. The Python gateway owns the
Jupyter token and directly adapts Contents/Sessions/Kernels REST plus the kernel
channels WebSocket into internal snapshots.

Human egui and WebMCP calls both enter `web/src/command-gateway.ts`. Never add a
second mutation path or a generic Jupyter forwarding method.

## Invariants

- Rust/WASM never fetches, opens sockets/files, launches processes, or knows URLs.
- The browser never receives Jupyter tokens, cookies, session IDs, or kernel IDs.
- Raw Jupyter data never enters egui state; normalize it to protocol snapshots.
- Use stable nbformat cell IDs; indexes are ordering only.
- Reject traversal, absolute paths, oversized data, stale revisions, malformed
  results, unknown protocol versions, and unsupported operations.
- Failed deterministic transitions leave prior state unchanged; result handling
  remains idempotent by command and idempotency key.
- Kernel execution uses `allow_stdin=false`; no terminals, package installation,
  arbitrary request forwarding, widgets/comms, or shell management.
- Jupyter, gateway, and frontend bind to loopback in non-container startup.
- `jupyter-server`, `jupyter-kernel-client`, `ipykernel`, and `nbformat` stay
  exactly pinned; protocol upgrades require real integration verification.

## Commands

- Install: `uv sync --python 3.12 && pnpm install`
- Develop: `scripts/dev.sh`
- Fast checks: `cargo test --workspace && pnpm test && uv run pytest -q`
- Full verification: `scripts/check.sh`
- Real acceptance: `scripts/smoke.sh`
- Docker: export `DIDACTION_JUPYTER_TOKEN`, then `docker compose up --build`

## Security boundaries

Notebook execution is arbitrary local code execution. This is not a sandbox or
multi-user service. Keep the workspace dedicated, credentials in environment,
ports loopback-bound, logs redacted, and browser results bounded. Never log
command bodies, cell sources, notebooks, outputs, tokens, authorization headers,
cookies, session IDs, or kernel IDs.

## Review entry points

Start at `crates/notebook-protocol/src/lib.rs`, then
`crates/notebook-core/src/lib.rs`, `web/src/command-gateway.ts`,
`services/gateway/app/jupyter_adapter.py`, and
`crates/notebook-egui/src/lib.rs`.
