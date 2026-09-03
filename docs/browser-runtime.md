# Browser kernel spike

An opt-in, real browser-only Python runtime. It does not replace the existing
Python gateway or migrate it to Rust yet. Server mode and its workspace-wide
driver coordination are unchanged.

## Start and stop

```sh
pnpm install --frozen-lockfile
pnpm build:wasm
pnpm dev:browser
```

Open `http://127.0.0.1:5175/?runtime=browser`. Stop the foreground process with
Ctrl+C. Existing Docker notebooks on ports 5173/5174 are unaffected. The starter
notebook includes arithmetic, Matplotlib, and intermediate output replacement
examples. Use the normal cell play button or Shift+Enter.

`pnpm build:browser` creates a static deployment in `dist`. Serve it with
`pnpm exec vite preview --host 127.0.0.1 --port 5175`, then use the same query
parameter. Other static hosts must supply `Cross-Origin-Opener-Policy: same-origin`
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
`BrowserKernel`. Kernel files currently live in temporary Pyodide memory, **not**
the notebook store or the server's configured workspace folder.

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
- No browser Julia, kernel selection, server folder mount, checkpoints, widgets,
  or WebIO is claimed. Unsupported operations return actionable errors.
- Display-ID replacement is tracked within one execution; cross-cell or later
  executions updating an earlier display are not implemented in this spike.
- Only the packaged environment is tested. PyPI fallback is disabled. WebMCP
  continues to reject shell/install magics.
- Workers are not a security boundary against notebook code using browser
  capabilities. Do not supply environment secrets or sensitive data, or share
  this origin with privileged applications.
- Browser storage can be cleared or run out of quota. Download `.ipynb` backups.
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
scripts/check.sh
```

The dedicated browser suite uses port 43175, not a live user gateway. It exercises
actual Python/WASM execution, egui/WebMCP convergence, plots, output replacement,
completion, inspection, interruption, restart, persistence and the second-tab
guard. Unit tests cover output ordering/coalescing, clear-after-wait, display IDs,
bounds, malformed output and paths.

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
