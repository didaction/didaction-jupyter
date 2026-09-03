# Browser-only environment

A separate, real browser-only Python runtime. The HTTP host serves static files;
protocol validation, storage and kernel execution all happen in the browser.
The native Rust gateway and server-side driver coordination are a separate build.

## Start and stop

```sh
pnpm install --frozen-lockfile
pnpm build:browser
pnpm serve:browser
```

Open `http://127.0.0.1:5175/`. Stop the foreground process with
Ctrl+C. Existing Docker notebooks on ports 5173/5174 are unaffected. The starter
notebook includes arithmetic, Matplotlib, and intermediate output replacement
examples. Choose **Open demo workspace** to load it, or **Import ZIP workspace**
to load your own notebooks and files. Use the normal cell play button or Shift+Enter.

Select the workspace kernel before opening it: **Python (Pyodide)** is the default;
**Python (xeus-python · experimental)** appears after the optional build below.
The chosen kernel is carried in the notebook URL for reloads.
Unsupported browser kernel names fail closed. For frontend development,
`pnpm build:wasm && pnpm dev:browser` serves the same environment with Vite HMR.

## Experimental xeus-python

Install `uv` and `micromamba` (tested with micromamba 2.9.0), then:

```sh
pnpm install --frozen-lockfile
pnpm prepare:xeus
pnpm build:browser
pnpm serve:browser
```

Choose **Python (xeus-python · experimental)** on the home page before opening a
workspace. Existing notebook URLs may select it with `kernel=xeus-python`; sources
and saved outputs are preserved, but kernels never share live Python variables.
Playgrounds inherit the selected runtime in their own isolated worker.

The optional bundle adds approximately 60 MB before HTTP compression. It uses
`@jupyterlite/xeus` 5.0.0, xeus-python 0.19.0, Python 3.13.1, NumPy 2.4.6,
Numba 0.67.0, llvmlite 0.49.0 and Matplotlib 3.11.1.
`deploy/xeus/explicit.lock` pins all 48 conda package URLs,
builds and MD5 checksums; `deploy/xeus/uv.lock` pins the isolated asset builder.
`environment.yml` documents the original solve, but normal preparation uses the
explicit lock, not a fresh solve. Build products stay ignored under `.runtime/`
and `web/public/xeus/`. Server builds do not include them.
Browser build/dev commands rebuild the adapter when the optional assets exist;
after editing the classic worker during an active dev session, run
`node scripts/build-xeus-worker.mjs` and restart the notebook kernel.

The classic worker subclasses the official `EmpackedXeusRemoteKernel`, adapts
Jupyter envelopes to the same bounded worker port, and waits for both execution
reply and idle before committing. It does not introduce another notebook command
path. The upstream package installer is replaced at bundle time with rejecting
functions, preventing its eager external registry request. Package-install and
shell magics are disabled. `pyodide-http` is excluded when packing: version 0.2.2
calls `to_js(dict_converter=...)`, which xeus's pyjs bridge does not implement.
Automatic urllib/requests browser HTTP patching is therefore not supported.
This is not a security sandbox: Python's browser bridge still has browser powers.

Stop terminates the xeus worker and loses live variables, even with isolation
headers. No widgets/comms or stdin integration is claimed. Reload preserves
notebooks, not kernel memory. Missing assets require `pnpm prepare:xeus` followed
by rebuilding the browser distribution.

To upgrade, solve `environment.yml` into a **new** emscripten-wasm32 prefix,
export exact package URLs/checksums into `explicit.lock`, update the npm and uv
locks, rebuild, and rerun both browser suites. Recheck the HTTP exclusion and
disabled installer against upstream. Never silently re-solve at deployment time.
See [source investigation](xeus-python-browser-investigation.md).

### Numba and Qrisp

`examples/xeus-numba.ipynb` demonstrates real `@njit` compilation, asserts a
nopython signature, and plots compiled results. The WASM Numba/llvmlite builds
come from emscripten-forge; ordinary native wheels cannot replace them. No xeus
source patch was needed. Kernel-generated cache files are still ephemeral;
persistent cross-session JIT caching is not promised by our one-way file mount.

Qrisp is **not installed or supported in this browser bundle**. Qrisp 0.9.7
requires unavailable WASM `jaxlib==0.7.1`. The older 0.5.4 release avoids JAX,
but its Qiskit dependency also failed the target-platform solve. Keep using
the native kernel for the quantum-school notebooks. See the exact candidates,
commands and primary-source evidence in [Qrisp compatibility](qrisp-wasm-compatibility.md).

To test an environment without replacing the working assets, use
`pnpm prepare:xeus --lock /absolute/candidate.lock --output /absolute/candidate/xeus`.
Then set `DIDACTION_XEUS_TEST_ASSETS=/absolute/candidate/xeus` when running
`pnpm exec playwright test --config playwright.browser-kernel.config.ts xeus-numba.spec.ts`.
The test serves those actual artifacts under the same worker URLs; it does not
mock kernel execution. Promote only after compiled-result and existing-runtime
regression tests pass.

## Deployment separation

- `pnpm build` (or `pnpm build:server`) produces server-only `dist/`.
  The existing Docker/gateway workflow uses this output and has no browser mode.
- `pnpm build:browser` produces browser-only `dist-browser/`, including pinned
  Python assets. Serve that folder at the HTTP site's root. No gateway, Python
  host process, API proxy, Jupyter Server or Docker kernel is needed.
- `pnpm serve:browser` serves the already-built files with isolation headers.
  A generic static HTTP server also works, for example
  `python3 -m http.server 5175 --bind 127.0.0.1 --directory dist-browser`;
  without isolation headers, Stop uses worker termination instead of shared
  interrupt buffers. Remote hosting requires HTTPS for Web Locks.
- `?runtime=browser` no longer selects a runtime; Vite's build mode fixes it.
  Browser and server outputs are independent and may be built in either order.

## Browser workspace startup and files

- The home icon at the top right, before Local, returns to the workspace chooser.
  It requires saved/idle notebooks and confirmation: saved files remain, but this
  tab's live kernels and temporary playgrounds are discarded. Import can then
  open another ZIP or reopen the demo/saved workspace. Each new ZIP import has
  its own origin-local IndexedDB database, including notebooks, artifacts and
  microscope sidecars. Identical paths in different workspaces do not conflict.
  The demo has its own reusable workspace. Existing pre-workspace storage is
  preserved intact as **Existing browser workspace**, since its original import
  boundaries cannot be recovered reliably.
  The header shows the active notebook filename instead of “local notebook”.

- Launch without a notebook query parameter to show the chooser. **Saved workspace**
  lists workspace names and notebook counts, with an expandable list of their
  current notebook paths. Continue opens the first notebook (alphabetically);
  all its other notebooks and files are available in the explorer. A `workspace`
  URL parameter preserves the selected database across reloads and notebook switches.
  Old URLs without it still address the existing storage. Reloading a valid notebook URL
  reopens it directly; opening the demo never replaces an existing demo.
- A ZIP must contain at least one nbformat 4 notebook. Subfolders, empty folders
  and binary/text artifacts are imported together. Notebooks are normalized to
  the bounded runtime schema and validated by Rust/WASM; unsupported notebook
  features are not preserved as raw files. Uploading never runs code.
- ZIP import is atomic and create-only: conflicting files or invalid notebooks
  reject the whole batch. Existing directories may merge. The explorer can
  subsequently create notebooks, files and folders, or upload individual files.
- Limits: 20 MB ZIP and expanded batch, 1 MB per entry, 1,000 stored items and
  20 MB persisted non-notebook file data. Ordinary stored/deflate ZIPs with UTF-8
  (or ASCII) names are supported. Encrypted, multi-disk and ZIP64 archives,
  symlinks, absolute/traversal paths and dot-prefixed path components are rejected.
  Exclude OS metadata such as `.DS_Store` before zipping.
- Uploads and normalized notebooks persist in origin-local IndexedDB; its v2
  upgrade preserves previously saved v1 notebooks. Nothing is sent to a server.
- Before kernel requests, uploaded artifacts are copied to `/workspace` inside
  that notebook's worker. The working directory is the notebook's parent folder:
  a notebook in `lesson/` can read `lesson/data.csv` using `open("data.csv")`.
  New uploads are copied on the next request; already mounted files are not
  repeatedly overwritten. Normalized notebook snapshots are not mounted as
  raw `.ipynb` files.
- This is a one-way copy, not a bidirectional filesystem mount. Files written
  or changed by Python disappear on worker restart; uploaded originals remain
  saved. Renaming an open notebook does not move its existing worker directory.
  Keep originals/backups outside browser storage. Only the bundled Python
  environment executes; importing a Julia notebook does not install Julia.

Static hosts can supply `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` to enable shared interrupt
buffers. Stop attempts cooperative interruption, then terminates the worker
after 1.5 seconds if the request has not settled. Without isolation it stops the
worker immediately. Termination loses variables and reports that explicitly.

Asset preparation downloads packages once, verifies SHA-256 digests, and reuses
verified copies. Runtime assets are same-origin: no gateway, Jupyter Server, or
runtime CDN is needed for the tested package set. Preparing assets needs network
access; browser execution alone does not make arbitrary deployments offline-ready.

## Shared command path

Human egui actions and WebMCP tools retain `CommandGateway` and WASM validation.
`BrowserNotebookTransport` implements `NotebookTransport`. It uses the shared
`notebook-runtime` Rust module to prepare authoritative cell-change proposals and
reduce kernel output; JavaScript does not implement those transitions separately.
Storage commits precede acknowledgement. The frontend optimistic replica remains
separate. See [migration status](rust-runtime-migration.md) for the native host work.

`WorkerKernel` owns JavaScript message correlation, worker lifetime and deadlines.
The worker subclasses JupyterLite's `PyodideRemoteKernel`; JupyterLite/IPython
own execution, completion, inspection and display hooks. Only explicit
execute/complete/inspect methods are dispatched. Widget comms, stdin and arbitrary
Jupyter forwarding are not exposed. Bounded normalized outputs return through
the existing frontend result/progress path.

`IndexedNotebookStore` owns origin-local notebook persistence, separately from
`BrowserKernel`. Saved artifacts are copied into temporary Pyodide memory;
kernel writes do not update IndexedDB or the server's configured workspace folder.

## Pinned runtime

- `@jupyterlite/pyodide-kernel` 0.8.5 and `pyodide` 314.0.5 are exact npm dependencies,
  with transitive versions/integrities in `pnpm-lock.yaml`.
- JupyterLite's bundled kernel, piplite and compatibility wheels are checked
  against their bundled index.
- `comm` 0.2.3 is pinned by URL and SHA-256 in the asset preparation script.
- IPython 9.12.0, Matplotlib 3.10.8, NumPy 2.4.6, Jedi 0.19.2 and dependencies come
  from the npm-pinned Pyodide lockfile. The preparation script walks that closure
  and verifies each downloaded package.

Upstream exported TypeScript declarations have dependency errors. `skipLibCheck`
skips declaration-file checking, not our application source checks. Actual
runtime compatibility is tested with the pinned assets.

## Deliberate limitations and safety

- Single-user only. An origin-wide Web Lock rejects another tab instead of
  allowing conflicting writes. This is not server-mode collaboration.
- Reload/closing a notebook stops its worker. Saved sources and outputs survive;
  Python variables, imported modules and temporary files do not.
- No browser Julia, arbitrary kernel installation, server folder mount, checkpoints, widgets,
  or WebIO is claimed. Unsupported operations return actionable errors.
- Display-ID replacement is tracked within one execution; cross-cell or later
  executions updating an earlier display are not implemented in this spike.
- Only the packaged environment is tested. PyPI fallback is disabled. WebMCP
  continues to reject shell/install magics.
- Workers are not a security boundary against notebook code using browser
  capabilities. Do not supply environment secrets or sensitive data, or share
  this origin with privileged applications.
- Browser storage can be cleared or run out of quota. Use **Export workspace** in
  the explorer for a ZIP backup of saved notebooks, folders, artifacts and
  microscope sidecars. The export reads both IndexedDB stores in one transaction.
  It excludes temporary kernel files and variables; save edits and finish running
  commands first. Limits are 1 MB per file, 1,000 items and 20 MB including ZIP
  overhead; oversized exports fail rather than omit data. The ZIP can be selected
  at browser workspace startup as a separate workspace. Within an open workspace,
  file uploads remain create-only.
  File → Create Checkpoint is disabled in browser mode; notebook download remains
  available for individual notebook backups without sidecars.
- Kernel side effects can occur even if saving/receiving a result fails. Do not
  blindly repeat failed executions. Large outputs fail bounds validation.
- The pinned JupyterLite coroutine path did not reliably settle a tight-loop
  SIGINT in testing, although bare Pyodide did. The worker-stop fallback is
  therefore necessary; native-style interrupt preserving variables is not promised.

## Verification

The verification run uses Node 24.19.0 and the pinned Playwright Chromium browser.

```sh
pnpm prepare:browser-kernel
pnpm build:wasm
pnpm run typecheck
pnpm test
pnpm test:browser-kernel
pnpm build:browser
pnpm test:browser-static
scripts/check.sh
```

The dedicated browser suite uses port 43175, not a live user gateway. It exercises
actual Python/WASM execution, egui/WebMCP convergence, plots, output replacement,
completion, inspection, interruption, restart, persistence and the second-tab
guard. Unit tests cover output ordering/coalescing, clear-after-wait, display IDs,
bounds, malformed output, paths and ZIP admission. Workspace browser tests import
a real compressed ZIP, read its data using Python, mount subsequent uploads,
check persistence, and reject conflicting imports without partial writes.
The browser-static test repeats real egui/WebMCP execution and plotting against
the production static build and asserts that no gateway API is requested.

The browser contract tests also use real WASM validation with injected storage
failures to check rollback and idempotency after uncertain execution outcomes.

Verified on 2026-09-03: `scripts/check.sh` passed Rust formatting, Clippy,
42 Rust tests, wasm32 checking, frontend formatting/typechecking, 22 frontend
unit tests, Python formatting/lint/typechecking and 47 Python tests, production
build, 3 standard browser tests and all 3 browser-kernel tests. Four existing
container-dependent browser tests were skipped by their normal guard. The real
Jupyter/ipykernel smoke passed execution, completion, edits, SVG and intermediate
stream/clear/refresh. The human edit/run/plot/reload browser scenario also passed
three consecutive standalone runs. WebMCP tests inject its registration API;
the registered handlers use the real runtime, not a mock kernel.

This verification also caught and fixed an existing mounted-WASM issue:
completion/inspection requests marked the UI dirty despite returning no snapshot.
They now preserve the prior sync state, keeping run controls and tool reads usable.

Review `web/src/browser-transport.ts`, `browser-kernel.worker.ts`,
`browser-kernel.ts`, `browser-store.ts`, and `browser-outputs.ts` first. See also
the [design investigation](jupyterlite-browser-runtime-investigation.md).
