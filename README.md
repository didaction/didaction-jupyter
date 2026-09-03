# didaction Jupyter

### Microscopes

Agents can create titled, cell-owned microscopes through WebMCP. Use the cell's
top-right **Microscopes** dropdown to open its full notebook-area shell, or the
cross beside its title to delete it and its content file after confirmation.
**Back to notebook** returns to normal editing. Opted-in followers mirror the
driver's microscope navigation; observers can also browse independently.
Both Rust server and browser-only builds support this foundation. Walkthroughs,
graphics and nested playgrounds are later steps. See [storage, tools and current
boundaries](docs/microscope.md).

### Workspace creation and uploads

In the native Rust server runtime, the explorer's **Create or upload** controls
create notebooks, empty files, and folders in the displayed directory. Enter
subfolders by clicking them; create parents before children. Upload accepts
multiple files, including `.ipynb`, CSV, images, and binary artifacts, up to
1,000,000 bytes each. Existing names are rejected rather than overwritten.
Uploaded notebooks are validated but never executed automatically. Click a
notebook to open it; other artifacts are listed for use by the server kernel.
Use Refresh in other clients to see new files. Batch uploads are sequential:
files saved before a failure remain saved; inspect the folder before retrying.

The `ArtifactTransport` interface owns workspace creation independently of
notebook execution. Its HTTP adapter calls the driver's authenticated
`POST /api/v1/artifacts` endpoint, which uses Jupyter Contents under the configured
root. Paths, payloads, notebook snapshots, and driver ownership are checked
server-side; no Jupyter credential enters the browser. Creation is serialized
with gateway notebook writes. Direct external Jupyter/filesystem writers are
outside this coordination: do not write the same destination concurrently.
Browser-only WASM mode implements this adapter using IndexedDB and also imports
folder trees from ZIP at startup (see below). The legacy Python gateway does not.
No file preview, deletion, replacement,
or artifact WebMCP tools are exposed in this first version.

`examples/sine-cosine.ipynb` contains the plotted example from the active notebook
(source only; run it in an IPython kernel with NumPy and Matplotlib).

A standalone local-first notebook frontend: egui compiled to WebAssembly, a
same-origin Rust gateway, and a real Jupyter Server/IPython kernel. It uses
Jupyter's native Contents, Sessions, Kernels, and kernel-channel protocols. No
MCP server sits between the gateway and Jupyter.

A separate [browser-only Python environment](docs/browser-runtime.md) is available:
`pnpm build:browser && pnpm serve:browser`, then open
`http://127.0.0.1:5175/`. This serves static files from `dist-browser/`;
JupyterLite/Pyodide runs in a Worker
through the same egui/WebMCP command path, with browser-local notebook storage.
An optional **xeus-python** WASM kernel can be prepared with `pnpm prepare:xeus`
before building. See [setup and experimental limitations](docs/browser-runtime.md#experimental-xeus-python).
At launch, select **Python (Pyodide)**, then choose **Open demo workspace**, **Import ZIP workspace**, or
**Continue saved workspace**. ZIP imports preserve subfolders and include notebooks
and data files; they never execute uploaded notebooks automatically. Files are
copied into the Python worker, with relative paths resolved from the notebook's
folder. Notebook reloads reopen saved work without showing the chooser.
ZIP limits: 20 MB compressed/expanded, 1 MB per file, 1,000 entries; stored/deflate
ZIP only, no encrypted archives, symlinks, hidden paths or overwriting.
Browser storage persists uploads, but files created/changed by Python are temporary.
It is single-user. `pnpm build` produces the separate server-only `dist/`;
the server build has no browser runtime switch, including via URL parameters.

## Frontend diagnostics

Markdown runs locally: Shift+Enter saves the edited source, renders Markdown,
and advances to the next cell. Selection ranges stay within one cell type.

WebMCP `insert_cell`, `insert_execute_code_cell`, and `move_cell` accept exactly
one of `before_cell_id`, `after_cell_id`, or `index`. Prefer stable-ID anchors:
they are resolved by the shared Rust model against the state being committed,
and a deleted anchor rejects the operation. `index` explicitly means absolute
position; queued absolute commands retain their expected revision and reject
intervening changes. The egui insertion and drag controls emit ID anchors too.
Insertion-plus-execution always executes the newly generated cell ID.

Use `highlight_cell` with `notebook_path`, `cell_id`, and optional `color`
(`blue`, `blue-light`, or `blue-deep`) for a separate pulsing agent border.
`clear_cell_highlight` takes the same notebook/cell identity. Clicking the cell
also dismisses it. Highlights are presentation-only, limited to 128 per view,
kept only in memory, and are not broadcast to collaborators or saved. Reduced
motion preferences turn the pulse into a static border. These tools do not
change selection, execute code, or bypass driver permissions for notebook edits.

The diagnostic waveform icon at the right end of the bottom status bar opens a right
inspector. It shows the Git commit embedded in the loaded WASM build (plus dirty
checkout status), not the server's current checkout. Builds without Git metadata
show `unknown`; container builds via `scripts/container.sh` pass this metadata.
For manual Docker builds, pass `DIDACTION_BUILD_GIT_SHA` and
`DIDACTION_BUILD_DIRTY` as build arguments.

The inspector keeps the latest 10 WebMCP calls by default; **Keep last** accepts
1–100. Only tool names, timestamps, durations and outcomes are retained, in this
tab's memory. Arguments, outputs, notebook paths and error bodies are not recorded.
Clear removes the history; reload resets both history and its limit. Human egui
actions are not WebMCP calls and do not enter this list. On narrow screens the
inspector temporarily hides the explorer, or occupies the working area on phones.

## Architecture

The native Rust gateway implements the same browser HTTP/NDJSON
interface and direct Jupyter REST/WebSocket adapter, including workspace-wide
driver/follow coordination. Start it with
`DIDACTION_GATEWAY_IMPLEMENTATION=rust bash scripts/dev.sh`.
Python remains an explicit rollback (`DIDACTION_GATEWAY_IMPLEMENTATION=python`).
See [Rust gateway migration](docs/rust-runtime-migration.md) for
startup, verification and known differences.

```text
egui action ─┐
             ├─ browser CommandGateway → WASM validation → /api/v1/commands
WebMCP tool ─┘                                      ↓
                                  direct Jupyter gateway adapter
                         Contents/Sessions/Kernels REST + kernel WebSocket
                                                   ↓
                 bounded NDJSON progress/final → WASM reconciliation → egui
```

Rust/WASM never performs fetch or opens a WebSocket. TypeScript owns browser
APIs and calls only the same-origin gateway. The gateway owns the Jupyter token,
confines notebook paths, correlates kernel messages, bounds outputs, and
normalizes nbformat into the versioned Rust protocol. Human actions and optional
browser WebMCP tools therefore share one validated mutation path.

The frontend exposes a transport-independent catalog of 15 notebook tools through
WebMCP when available, including stable-ID cell editing and execution. See
[frontend tools](docs/frontend-tools.md) for schemas, architecture, limits, and
real-browser verification. This does not add an MCP backend or hosted dependency.

The **Files** sidebar browses folders and notebooks inside the configured Jupyter
workspace. Opening another notebook preserves saved files and existing kernel
sessions; save pending edits and finish execution before switching. Each browser
tab scopes its commands to its selected notebook. Traversal, hidden paths and
symlinks outside the workspace are rejected. This confines notebook/file access,
not arbitrary code executed by a trusted kernel.

For the KIT control-systems notebooks, use the pinned
[Julia course runtime](docs/julia-course.md): `bash scripts/julia-course.sh up`.
It runs separately on port 5174 and leaves the default deployment intact.

Cell execution uses `/api/v1/commands/stream`. Each bounded NDJSON event is a
normalized notebook snapshot derived from an IOPub update; `clear_output` and
`update_display_data` replace prior state before the idle final result. Partial
snapshots are persisted so a refresh observes the latest received kernel state.

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

The workspace folder, opened notebook, and kernelspec are immutable startup
configuration. For example:

```bash
DIDACTION_NOTEBOOK_WORKSPACE=/absolute/notebooks \
DIDACTION_NOTEBOOK_PATH=course/week-1.ipynb \
DIDACTION_KERNEL_NAME=python3 \
DIDACTION_ALLOWED_ORIGINS='https://notebooks.example,http://localhost:5173' \
scripts/dev.sh
```

The path is relative to the configured workspace and cannot contain traversal.
`DIDACTION_ALLOWED_ORIGINS` is an optional comma-separated list of exact
`http://` or `https://` frontend origins. Same-origin requests remain allowed;
wildcards, paths, credentials, query strings, and fragments are rejected at
startup. The allowlist controls both request admission and CORS preflights and
must also be applied to any future browser-facing WebSocket handshake.
Browser and WebMCP callers cannot select a different path or kernel. List
installed kernelspecs with:

```bash
uv run jupyter kernelspec list
```

If the desired environment contains `ipykernel` but is not already registered,
provide its Python executable at startup. The launcher creates a repository-local
kernelspec under `.runtime/kernel-prefix` and does not modify user-wide Jupyter
configuration:

```bash
DIDACTION_NOTEBOOK_WORKSPACE=/absolute/notebooks \
DIDACTION_NOTEBOOK_PATH=course/week-1.ipynb \
DIDACTION_KERNEL_NAME=course-environment \
DIDACTION_KERNEL_PYTHON=/absolute/course/.venv/bin/python \
scripts/dev.sh
```

### Docker

```bash
bash scripts/container.sh up
```

This builds the frontend/gateway and starts the existing Jupyter
`quay.io/jupyter/minimal-notebook` image, pinned by multi-architecture digest in
`docker-compose.yml`. No local Rust, Node, or Python installation is required.
Only `http://127.0.0.1:5173` is published. Jupyter stays on the private container
network. Stop with `bash scripts/container.sh down`; notebooks remain on disk.

See [container deployment](docs/container-deployment.md) for custom images,
workspaces, kernel secrets, connection settings, and attach mode.

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
executes through a real IPython kernel, verifies `42`, requests completion,
checks rich graph output, and asserts ordered intermediate stream/clear/final
events plus refresh reconciliation.

## Security warning

Notebook execution is arbitrary local code execution. This project is a
single-user development runtime, not a sandbox or remote multi-user service.
Run only trusted notebooks. Services bind to loopback by default; paths are
workspace-relative; credentials stay server-side; source, notebook contents,
outputs, tokens, cookies, session IDs, and kernel IDs are excluded from routine
logs and browser-visible results.

HTML/JavaScript output, widgets/comms, terminals, and arbitrary gateway/Jupyter
forwarding are deliberately unavailable. Trusted human-authored code cells may
use the pinned kernel `pip` through IPython's `%pip`; package installation remains
unavailable to WebMCP and typed gateway commands. PNG and SVG graph output are
bounded; SVG is decoded only by egui's image loader.

## License

Copyright 2026 didaction. Original project material is licensed under the
[Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
Third-party dependencies, fonts and imported content retain their own licenses;
see [Third-party licenses](THIRD_PARTY_LICENSES.md) for the initial inventory and
release checklist. This license does not grant rights to third-party notebooks
or datasets that you import into a workspace.

## Current limitations

Multiple frontend clients now use [single-driver collaboration](docs/collaboration.md):
the first connection drives; observers receive live committed changes and output.
`get_collaboration` and `change_notebook_driver` expose role discovery and handoff.
This is local connection coordination, not authenticated remote multi-user hosting.

- One driver per notebook per gateway process; external JupyterLab edits can still conflict.
- Close other collaborators before renaming a notebook.
- Math notation is locally typeset from a bounded LaTeX subset with MiTeX and
  Typst; arbitrary HTML is reduced to safe readable text/table output.
- Structural undo does not restore cleared kernel outputs; rerun the cell instead.
- Cell collapse and line-number preferences last for the browser session and are
  not yet persisted in notebook metadata.
- `egui_code_editor` is pinned to `0.2.17`, the release compatible with this
  workspace's egui `0.32`; its newer egui `0.35` line cannot be mixed in directly.
- No ipywidgets/comms, debugger, terminal, file browser, nbextensions, or trust UI.
- WebMCP remains experimental and feature-detected; the notebook works without it.
