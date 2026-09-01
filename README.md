# didaction Jupyter

A standalone local-first notebook frontend: egui compiled to WebAssembly, a
same-origin FastAPI gateway, and a real Jupyter Server/IPython kernel. It uses
Jupyter's native Contents, Sessions, Kernels, and kernel-channel protocols. No
MCP server sits between the gateway and Jupyter.

## Architecture

```text
egui action ─┐
             ├─ browser CommandGateway → WASM validation → /api/v1/commands
WebMCP tool ─┘                                      ↓
                                  direct Jupyter gateway adapter
                         Contents/Sessions/Kernels REST + kernel WebSocket
                                                   ↓
                              bounded result → WASM reconciliation → egui
```

Rust/WASM never performs fetch or opens a WebSocket. TypeScript owns browser
APIs and calls only the same-origin gateway. The gateway owns the Jupyter token,
confines notebook paths, correlates kernel messages, bounds outputs, and
normalizes nbformat into the versioned Rust protocol. Human actions and optional
browser WebMCP tools therefore share one validated mutation path.

See [frontend parity](docs/frontend-parity.md) for the prioritized compatibility
matrix and [direct protocol investigation](docs/direct-jupyter-protocol-investigation.md)
for the design rationale and official source references.

## Install and run

Requirements: Rust stable with `wasm32-unknown-unknown`, Python 3.12, `uv`,
Node.js, pnpm, and `wasm-pack`.

```bash
uv sync --python 3.12
pnpm install
rustup target add wasm32-unknown-unknown
scripts/dev.sh
```

Open `http://127.0.0.1:5173`. The generated Jupyter token remains in the service
environment and is never printed. The default `notebook-parity-demo.ipynb`
contains executable completion and SVG graph examples.

To select another installed kernelspec, change `kernel` in
`web/src/bootstrap.ts`; list kernels with:

```bash
uv run jupyter kernelspec list
```

### Docker

```bash
export DIDACTION_JUPYTER_TOKEN="$(openssl rand -hex 24)"
docker compose up --build
```

Jupyter and the gateway are published on loopback only.

## Verify

```bash
scripts/check.sh
```

Focused checks:

```bash
cargo test --workspace --all-features
pnpm test
uv run pytest -q
pnpm run test:browser
scripts/smoke.sh
```

The smoke test creates a notebook, performs stable-ID cell edits and moves,
executes through a real IPython kernel, verifies `42`, requests completion, and
checks rich graph output.

## Security warning

Notebook execution is arbitrary local code execution. This project is a
single-user development runtime, not a sandbox or remote multi-user service.
Run only trusted notebooks. Services bind to loopback by default; paths are
workspace-relative; credentials stay server-side; source, notebook contents,
outputs, tokens, cookies, session IDs, and kernel IDs are excluded from routine
logs and browser-visible results.

HTML/JavaScript output, widgets/comms, terminals, package installation, and
arbitrary gateway/Jupyter forwarding are deliberately unavailable. PNG and SVG
graph output are bounded; SVG is decoded only by egui's image loader.

## Current limitations

- Single-writer notebook saves; simultaneous edits from JupyterLab can conflict.
- Basic Markdown rendering rather than Jupyter's complete CommonMark/math stack.
- Completion requests currently target the end of the active source and present
  a bounded editor dropdown with keyboard and mouse selection; signature help
  and continuous completion are future work.
- `egui_code_editor` is pinned to `0.2.17`, the release compatible with this
  workspace's egui `0.32`; its newer egui `0.35` line cannot be mixed in directly.
- No ipywidgets/comms, debugger, terminal, file browser, nbextensions, or trust UI.
- WebMCP remains experimental and feature-detected; the notebook works without it.
