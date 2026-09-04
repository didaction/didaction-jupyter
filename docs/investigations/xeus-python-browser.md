# Xeus Python browser integration investigation

Research date: 2026-09-03. This note inspects official source, primarily the
`jupyterlite/xeus` **v5.0.0** tag. It is an implementation reference, not evidence
that this repository's browser adapter has passed acceptance tests.

## Practical conclusion

Use the `EmpackedXeusRemoteKernel` worker layer without the JupyterLab frontend.
It loads an Emscripten Xeus module, unpacks the Python environment, initializes
Python, and delivers complete Jupyter messages. A custom worker can subclass it
and keep this application's existing bounded execute/complete/inspect port and
one-way artifact copy. Do not replace the command gateway or notebook storage.
The class is exported from the package's `lib/worker` subpath, rather than its
main index. [Worker implementation](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus/src/worker.ts),
[package entry points](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus/src/index.ts).

Important: `xpython.js` and `xpython.wasm` alone are insufficient. The loader also
needs the packed environment metadata and package archives, and some builds need
shared libraries. `.data` is optional, not universally present.
[Asset discovery and packing](https://github.com/jupyterlite/xeus/blob/v5.0.0/jupyterlite_xeus/add_on.py).

## Build assets from precompiled packages

The supported builder installs Emscripten packages with micromamba and packages
them with empack; it does not require compiling CPython/Xeus locally. The builder
invokes micromamba with `--platform=emscripten-wasm32`, `--no-pyc` and
`--relocate-prefix ""`. The documented installation calls for micromamba 2.0.5.
[Environment creation source](https://github.com/jupyterlite/xeus/blob/v5.0.0/jupyterlite_xeus/create_conda_env.py),
[installation documentation](https://jupyterlite-xeus.readthedocs.io/en/latest/index.html).

For a staging directory containing `environment.yml`:

```yaml
name: xeus-python-kernel
channels:
  - https://prefix.dev/emscripten-forge-4x
  - https://prefix.dev/conda-forge
dependencies:
  - xeus-python
```

```sh
uv run --no-project \
  --with jupyterlite-xeus==5.0.0 \
  --with jupyterlite-core==0.7.0 \
  jupyter lite build \
  --lite-dir /absolute/staging-directory \
  --output-dir /absolute/asset-output \
  --XeusAddon.environment_file=environment.yml
```

These commands are an application of the official build workflow and source
flags, not a recorded successful execution. Add required scientific packages
to the same environment before building. Preserve the entire output `xeus/`
directory under the application's static asset root; the JupyterLab app bundles
produced alongside it need not be served by the custom frontend.
[Environment documentation](https://jupyterlite-xeus.readthedocs.io/en/latest/environment.html),
[build implementation](https://github.com/jupyterlite/xeus/blob/v5.0.0/jupyterlite_xeus/add_on.py).

Expected builder-owned layout, with the executable basename read from generated
`kernel.json` rather than assumed:

```text
xeus/
  kernels.json
  xeus-python-kernel/
    bin/xpython.js
    bin/xpython.wasm
    bin/xpython.data             # only when supplied by the package
    xpython/kernel.json
    xpython/<shared-libraries>   # when specified by metadata.shared
    libxeus.so                  # when supplied by the package
    empack_env_meta.json
    kernel_packages/*.tar.gz
```

The builder rewrites `kernel.json`'s `argv[0]` to
`xeus/<environment>/bin/<executable>.js`, packs the environment with relocation
prefix `/`, copies declared shared libraries, and writes `kernels.json` entries
containing `kernel` and `env_name`.
[Exact builder layout](https://github.com/jupyterlite/xeus/blob/v5.0.0/jupyterlite_xeus/add_on.py).

### Reproducibility boundary

Pinning `jupyterlite-xeus` does **not** pin the separately solved `xeus-python`
runtime. Capture every resolved runtime version/build and package checksum from
the successful build, plus the generated assets' SHA-256 hashes. Lock build-tool
transitives and npm transitives too; retain the complete verified artifact set.
An environment containing only `xeus-python` is a discovery solve, not a
reproducible lock. The builder can instead consume a pre-created prefix via
`--XeusAddon.prefix=/absolute/prefix`, enabling an independently locked conda
environment to be packed. These are integration recommendations based on the
builder's solve and prefix modes.
[Prefix mode](https://github.com/jupyterlite/xeus/blob/v5.0.0/docs/advanced.md),
[solver inputs](https://github.com/jupyterlite/xeus/blob/v5.0.0/jupyterlite_xeus/create_conda_env.py).

Verified release metadata:

| Package                              | Inspected version or declared compatibility |
| ------------------------------------ | ------------------------------------------- | --- | ------- |
| `@jupyterlite/xeus`                  | 5.0.0                                       |
| `@jupyterlite/xeus-core`             | 5.0.0                                       |
| `@emscripten-forge/mambajs`          | Xeus declares `^0.21.4`                     |
| `@emscripten-forge/mambajs-core`     | Xeus core declares `^0.21.2`                |
| `@jupyterlite/services`              | `^0.7.0                                     |     | ^0.8.0` |
| `@jupyterlab/coreutils` / `services` | `^6.5.0` / `^7.5.0`                         |

These ranges are compatibility declarations, not suggested lockfile pins.
No exact `xeus-python` package build was established by this source-only research.
[Xeus package](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus/package.json),
[core package](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-core/package.json).

## Standalone worker bootstrap

Conceptual integration skeleton (needs bundling and real-browser verification):

```ts
import { EmpackedXeusRemoteKernel } from "@jupyterlite/xeus/lib/worker";

class NotebookXeusKernel extends EmpackedXeusRemoteKernel {
  protected initializeStdin(): void {
    globalThis.get_stdin = () => ({ error: "stdin is disabled" });
  }

  async mount(): Promise<void> {
    // This app copies validated artifacts into Module.FS separately.
  }
}

const remote = new NotebookXeusKernel();
await remote.initialize({
  baseUrl: assetRoot,
  kernelId: internalWorkerId,
  browsingContextId: "",
  mountDrive: false,
  kernelSpec: {
    ...generatedKernelJson,
    name: "xpython",
    dir: "xpython",
    envName: "xeus-python-kernel",
  },
  empackEnvMetaLink: `${assetRoot}xeus/xeus-python-kernel`,
});
await remote.ready();
```

Supply an absolute `assetRoot` with a trailing slash. The extra `name`, `dir`, and
`envName` fields reproduce the official extension's enrichment of the generated
spec. Explicitly provide `empackEnvMetaLink`: its fallback uses
`xeus/kernels/<dir>`, whereas current build output stores metadata at
`xeus/<envName>`. Python bootstrap is selected by `kernelSpec.name === 'xpython'`.
[Extension initialization](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-extension/src/index.ts),
[worker initialization](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus/src/worker.ts).

The worker implementation uses `importScripts(binaryJS)` and the global
`createXeusModule`. For a custom bundle, a classic IIFE worker is a practical
starting point; do not assume a raw module worker can execute `importScripts`.
This is a bundling recommendation requiring a browser test, not an upstream
standalone deployment recipe. Avoid importing the `comlink.worker` entry point
merely to reuse its class: that entry point also constructs and exposes a worker.
[Loader source](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus/src/worker.ts),
[Comlink entry point](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus/src/comlink.worker.ts).

For a direct-module implementation, upstream ordering is:

1. Set `globalThis.toplevel_promise` and `toplevel_promise_py_proxy` to `null`.
2. Import the kernel JS, configure `locateFile`, call `createXeusModule(options)`.
3. Await `waitRunDependencies(Module)`.
4. Fetch `empack_env_meta.json`; convert it with `empackLockToMambajsLock`;
   call `bootstrapEmpackPackedEnvironment` against `kernel_packages/`.
5. Call `bootstrapPython({prefix, pythonVersion, Module})` for xpython.
6. Load shared libraries separately only for Emscripten older than version 4.
7. Install `get_stdin`, construct `new Module.xkernel(kernelSpec.argv)`, get its
   server with `get_server()`, and call `xkernel.start()`.

Prefer the existing superclass to reproducing all this ABI-sensitive setup.
[Core ordering](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-core/src/worker.base.ts),
[environment and Python bootstrap](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus/src/worker.ts).

## Filesystem and bounded requests

The module exposes `FS`; `cd` uses `FS.chdir`, and `isDir` uses `lookupPath` and
`FS.isDir`. Upstream Jupyter Contents synchronization mounts a `DriveFS` using
`FS.mkdir`, `FS.mount`, and `FS.chdir`. It is optional for our one-way copied
workspace: keep artifact copying into `/workspace` distinct from saving
notebooks in IndexedDB. Do not mount the full environment over `/workspace` or
let workspace paths overwrite Python's root libraries.
[Filesystem APIs](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-core/src/worker.base.ts),
[upstream mount](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus/src/comlink.worker.ts),
[local filesystem contract](../browser-runtime.md).

The remote API is `await remote.processMessage({msg})`. Underneath it calls
`xserver.notify_listener(msg)`. Both execution and completion/inspection use
full Jupyter messages, not Python source strings. Always include `buffers: []`:
the native bridge reads `buffers.length` unconditionally. A minimal envelope is:

```ts
const msg = {
  channel: "shell",
  header: {
    msg_id: requestId,
    session: internalSession,
    username: "browser",
    date: new Date().toISOString(),
    version: "5.3",
    msg_type: "execute_request",
  },
  parent_header: {},
  metadata: {},
  buffers: [],
  content: {
    code,
    silent: false,
    store_history: true,
    user_expressions: {},
    allow_stdin: false,
    stop_on_error: true,
  },
};
await remote.processMessage({ msg });
```

Use `complete_request` content `{code, cursor_pos}`, and `inspect_request`
content `{code, cursor_pos, detail_level}`.
[Jupyter request specification](https://jupyter-client.readthedocs.io/en/stable/messaging.html).
These must remain internal envelopes
behind the existing explicit application methods, not become a generic external
forwarding endpoint. The C++ server dispatches incoming shell/control/stdin
channels and publishes outgoing messages through `self.postMessage`, adding
`channel: 'shell'` or `'iopub'`. Outputs already contain `header`, `parent_header`,
`metadata`, `content`, and `buffers`.
[Remote request path](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-core/src/worker.base.ts),
[native message conversion](https://github.com/jupyter-xeus/xeus-lite/blob/main/src/xembind.cpp),
[native channel routing](https://github.com/jupyter-xeus/xeus-lite/blob/main/src/xserver_emscripten.cpp).

Correlate output by `parent_header.msg_id`, preserve IOPub ordering, and do not
treat `processMessage()` resolution as execution completion. For execution,
wait for the matching shell `execute_reply` and idle status while reducing
stream/display/error/clear/update messages through the current output reducer.
Completion and inspection resolve on their corresponding shell replies.
In particular, upstream tracks top-level await through global promises; before
a subsequent request it awaits the previous promise and deletes its Python proxy.
Test top-level await and errors explicitly. This completion policy is an
integration recommendation grounded in the async request implementation and
the existing protocol contract.
[Await handling](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-core/src/worker.base.ts),
[local invariants](../../AGENTS.md).

Worker startup/package-manager logs may arrive as `{_stream: ...}` without a
Jupyter header. Handle these separately from correlated kernel output; do not
assign unrelated startup logs to an execution. The upstream wrapper also handles
`OPEN_TAB`; a custom worker host need not grant notebook code that UI behavior.
The superclass preprocesses package-install magics, so retaining it requires
preserving the application's trusted-human/tool boundary and package policy.
[Host filtering](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-core/src/kernel.base.ts),
[magic processing](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-core/src/worker.base.ts).

## Verification still required

No cooperative Python interrupt was established by this research. Upstream
disposal terminates the worker; maintain the existing explicit variable-loss
warning for that fallback. Test real execution, print/error, completion,
inspection, Matplotlib output, clear/update display semantics, top-level await,
artifact reads, restart, and static same-origin asset loading before marking the
new choice supported. An npm build alone does not establish CPython environment
or Emscripten ABI compatibility.
[Worker disposal](https://github.com/jupyterlite/xeus/blob/v5.0.0/packages/xeus-core/src/kernel.base.ts),
[browser verification contract](../browser-runtime.md).
