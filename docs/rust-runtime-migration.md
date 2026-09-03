# Shared Rust runtime migration

## Current status

The first extraction is implemented, not the complete gateway rewrite.
`notebook-runtime` is a pure Rust module compiled natively and into the existing
frontend WASM artifact. It owns:

- `prepare(snapshot, command)`: validated cell-change proposals using the existing
  core transition logic, including revision checks and final snapshot bounds.
- `OutputState::apply(event)`: atomic bounded stream/error/MIME reduction,
  stream coalescing, deferred clearing and display-ID replacement.
- `OutputState::apply_jupyter_message(message)`: native Jupyter message envelope
  adaptation to the same reducer used for JupyterLite browser bundles.

The browser transport now uses `prepareRuntimeCommand` and `reduceKernelOutput`
WASM exports. Its separate TypeScript reducer has been removed. JavaScript still
owns Workers, request correlation, deadlines and IndexedDB. Browser notebooks,
kernel code and environment packages remain separate from the runtime module.

The Python gateway remains the deployed native implementation. Its normalization,
Jupyter connection, persistence, scheduling, collaboration and HTTP routes have
not been replaced. Native reducer equivalence tests are not a claim that the
running native gateway uses Rust yet.

## Interface and trust decisions

Preparation returns a proposal, not a successful execution or storage commit.
Hosts must enforce actor authority before requesting effects and commit durable
storage before acknowledging a command. An execution may change kernel variables
even when persistence fails; retries must retain that uncertainty.

The runtime has no browser, network, filesystem, process or clock dependencies.
Jupyter is the kernel protocol; Docker is deployment packaging. The native adapter
will use Jupyter REST and kernel-channel WebSockets, while the browser adapter
continues JavaScript message passing to JupyterLite/Pyodide. Kernels are not linked
into this Rust module. The native host can use async traits; the pure runtime
interface should return explicit proposals/events rather than hide I/O in egui.

The shared reducer enforces the protocol's aggregate per-cell output bound rather
than relying on later frontend validation. It currently tracks display IDs per
execution, matching the browser spike; cross-cell display updates remain a gap.

## Remaining native migration gates

1. Add a native Rust host and Jupyter adapter alongside the Python reference.
   Preserve `/api/v1/config`, command JSON, NDJSON execution progress, notebook
   listing, downloads/checkpoints and existing collaboration/follow routes.
2. Move committed revisions, bounded idempotency and uncertain-execution handling
   into the authoritative runtime; keep storage and kernel effects injectable.
3. Port workspace-wide single-driver policy, handoff, presence expiry, follower
   snapshots and selections. Authenticate client identity in the host; never
   treat browser-supplied driver claims as authority. Keep observers and their
   WebMCP mutations blocked server-side.
4. Run the same black-box scenarios against both gateways: edits, completion,
   plots, clear/update streaming, timeout/interrupt, reconnect, duplicate requests,
   path confinement, response bounds and secret redaction. Use real IPython and
   the Julia container before claiming parity with current server mode.
5. Change Docker/startup defaults only after those gates pass, keeping a documented
   rollback to the Python gateway. Do not retire Python tests as a substitute for
   demonstrating native parity.

The browser-facing transport remains JSON/NDJSON over the current same-origin
HTTP interface. No MCP backend is being reintroduced, and no generic kernel or
MCP forwarding method is added.

## Verification

`cargo test -p notebook-runtime` tests the native interface. Existing
`web/src/browser-outputs.test.ts` loads the actual WASM exports, so it tests the
same implementation rather than a mocked substitute. `pnpm test:browser-kernel`
exercises real Pyodide execution, streaming, plots, persistence and the human/tool
path. Build WASM before running those frontend tests; `scripts/check.sh` does so.

Verification on 2026-09-03: full `scripts/check.sh` passed, including native/wasm32
checks, frontend and Python checks, all three browser-kernel tests and the real
Jupyter/ipykernel smoke. Four pre-existing container-dependent browser tests were
skipped. The five shared-runtime native tests and workspace Clippy also passed
after adding the final command-preparation regression.
