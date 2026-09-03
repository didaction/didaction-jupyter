# Shared Rust runtime migration

## Current status

The shared extraction and native Rust gateway are implemented. Rust is the
default in development and container startup; Python is retained for rollback.
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

`notebook-gateway` now owns native HTTP hosting, Jupyter Contents/Sessions/Kernels
REST, bounded kernel-channel WebSockets, persistence, revision tracking,
idempotency, execution scheduling and collaboration routes. It calls the same
Rust preparation and output reducer as browser mode, with no Python gateway or
MCP proxy in this path. `notebook-runtime::collaboration` is transport-independent:
hosts provide capability tokens, public IDs and monotonic time. First connection
is the default workspace-wide driver policy; hosts can inject another policy.

Existing running demos have not been restarted. The native host has passed real
IPython, four existing multi-browser suites and an isolated Rust-container/IJulia
test with static Plots output, completion and persisted kernel state.

## Launch and verification

```bash
# Same existing Jupyter, workspace, kernelspec and secret settings:
DIDACTION_GATEWAY_IMPLEMENTATION=rust bash scripts/dev.sh

# Attach only the native gateway to an existing server:
DIDACTION_JUPYTER_URL=http://127.0.0.1:8888 \
DIDACTION_JUPYTER_TOKEN_FILE=/absolute/path/to/token \
DIDACTION_STATIC_DIR="$PWD/dist" \
DIDACTION_GATEWAY_IMPLEMENTATION=rust bash scripts/gateway.sh

# Real IPython plus all four existing multi-browser integration suites:
DIDACTION_GATEWAY_IMPLEMENTATION=rust DIDACTION_NATIVE_BROWSER_CHECK=1 \
  bash scripts/smoke.sh

# Container target; frontend is compiled in the build stage:
bash scripts/container.sh prepare
docker compose -f docker-compose.yml -f deploy/compose.rust.yml up --build -d
```

Native bind defaults to `127.0.0.1:8080`; override with
`DIDACTION_GATEWAY_BIND`. Container packaging sets `0.0.0.0:8080` internally;
Compose still publishes loopback only. Docker target `gateway-rust-prebuilt`
packages an already built `dist`; `gateway-rust` builds both WASM and TypeScript.
Neither native runtime target contains Python. Stop using the same Compose files
and `down`. Roll back by selecting `DIDACTION_GATEWAY_IMPLEMENTATION=python` or
using `-f docker-compose.yml -f deploy/compose.python.yml up --build -d` when
recreating the gateway. Python's source and tests remain intact.

The HTTP implementation uses pinned Axum/Reqwest/Tokio-Tungstenite. Kernel
WebSockets use Jupyter's documented [default protocol](https://jupyter-server.readthedocs.io/en/stable/developers/websocket-protocols.html).
Do not print upstream library errors: they can embed credentials or notebook
data. The host emits only a fixed startup failure message and no access logs.

## Native differences and conservative safeguards

- Each kernel request connects a scoped WebSocket and correlates shell/IOPub by
  message ID. Kernel lifetime remains with Jupyter Sessions, not the socket.
- Accepted commands run independently of browser socket lifetime. Progress uses
  a bounded queue; slow clients may skip intermediate snapshots, never re-execute
  commands to catch up. Collaboration long polls retain the latest full state.
- Idempotency entries are notebook/client scoped; a reused key with changed
  input is rejected. A 4,096-entry in-process ledger retains accepted IDs even
  when the 16 MB replay cache is cleared. At the ledger limit, restart is required.
  Neither revisions nor this ledger survive gateway process restart; reconnect
  before new commands, and never automatically replay uncertain execution.
- Execution failures conservatively quarantine further writes until explicit
  restart. A timeout requests interrupt; it does not claim the kernel rolled back.
- Creating a notebook produces one empty code cell rather than the Python
  gateway's special demo template. Existing notebook contents are preserved.
- Unsupported widgets/comms, stdin and standalone arbitrary-code execution remain
  unsupported. MIME selection matches the shared browser reducer. Saved original
  MIME bundles/attachments are preserved through edits where applicable.
- Cross-cell display-ID updates remain a pre-existing shared-runtime limitation.

## Interface and trust decisions

Preparation returns a proposal, not a successful execution or storage commit.
Hosts must enforce actor authority before requesting effects and commit durable
storage before acknowledging a command. An execution may change kernel variables
even when persistence fails; retries must retain that uncertainty.

The runtime has no browser, network, filesystem, process or clock dependencies.
Jupyter is the kernel protocol; Docker is deployment packaging. The native adapter
uses Jupyter REST and kernel-channel WebSockets, while the browser adapter
continues JavaScript message passing to JupyterLite/Pyodide. Kernels are not linked
into this Rust module. The native host can use async traits; the pure runtime
interface should return explicit proposals/events rather than hide I/O in egui.

The shared reducer enforces the protocol's aggregate per-cell output bound rather
than relying on later frontend validation. It currently tracks display IDs per
execution, matching the browser spike; cross-cell display updates remain a gap.

## Regression gates for further migration changes

1. Verify the native Rust host and Jupyter adapter alongside the Python reference.
   Preserve `/api/v1/config`, command JSON, NDJSON execution progress, notebook
   listing, downloads/checkpoints and existing collaboration/follow routes.
2. Preserve committed revisions, bounded idempotency and uncertain-execution handling.
   These native scheduling/ledger details currently live in the Rust host, while
   preparation, output reduction and driver policy live in the shared pure module.
3. Preserve workspace-wide single-driver policy, handoff, presence expiry, follower
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
checks, 27 frontend tests, 47 Python tests, four real browser-kernel tests,
Python/Rust IPython smoke tests and the Rust-specific contract suite. The normal
mock-browser pass skips four integration suites; all four then passed against
the isolated real Rust gateway (collaboration, explorer, follow, WebMCP).
The additional native fault-injection tests passed for malformed upstream JSON,
oversized responses, timeout/disconnect and redacted errors.

`bash scripts/native-container-check.sh` passed against the built
`gateway-rust-prebuilt` image and existing Julia course image: real IJulia `42`,
static Plots image output, persistent variables, completion, and egui/WASM browser
mounting. It creates a dedicated Compose project and temporary notebook directory,
then removes only those test containers/files. It does not execute or modify the
user's course notebooks. This container check is separate from `check.sh` because
it requires prebuilt local images and Docker availability.
