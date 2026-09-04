# JupyterLite browser-runtime investigation

Research date: 2026-09-03. Scope: design evidence, not a migration decision or implementation. No runtime integration was built or tested.

## Conclusion

**Recommendation:** keep the native gateway/Jupyter deployment and browser-only execution as two hosts of a shared, transport-independent notebook runtime. Use separate kernel and notebook-storage adapters. JupyterLite provides useful browser-kernel machinery, but it is not a replacement for this application's command validation, authoritative notebook state, collaboration authority, or egui output rendering.

This is consistent with the repository's separation of bounded protocol, optimistic frontend state, egui rendering, TypeScript browser APIs, and gateway-owned Jupyter access. The current invariants also prohibit raw Jupyter data in egui, direct Rust/WASM I/O, widgets/comms, and a second mutation path. Those remain constraints unless deliberately revised. [Local architecture and invariants](../../AGENTS.md).

## What is established

### Browser kernels are separate runtimes, not part of egui's WASM module

JupyterLite lists both Pyodide and Xeus Python as Python kernels running in Web Workers. Its notebook/file persistence is browser storage; it supports multiple kernel instances. These are features of the JupyterLite application, not guarantees about a custom egui host. [JupyterLite overview](https://jupyterlite.readthedocs.io/en/stable/).

The inspected `PyodideKernel` constructs a JavaScript Worker and selects coincident or Comlink communication according to cross-origin isolation. The worker separately initializes Pyodide, its filesystem, package manager, and Python kernel. Thus an egui/Rust WASM frontend can coexist with a different, Worker-owned Python/WASM runtime; sharing Rust logic does not mean linking Python into the egui binary. [Kernel host source](https://raw.githubusercontent.com/jupyterlite/pyodide-kernel/main/packages/pyodide-kernel/src/kernel.ts), [worker source](https://raw.githubusercontent.com/jupyterlite/pyodide-kernel/main/packages/pyodide-kernel/src/worker.ts).

**Recommendation:** let JavaScript own Worker lifecycle, browser APIs, and cross-runtime messages. Keep Rust portable through typed commands/events and explicit host effects. Do not synchronously run Python on the UI thread: Pyodide documents Worker isolation as the way to avoid blocking that thread, and Workers cannot directly access the page DOM. [Pyodide Worker guide](https://pyodide.org/en/stable/usage/webworker.html).

### Reuse the message-facing layer, not the JupyterLab shell

The inspected `PyodideKernel` extends `BaseKernel`, implements `IKernel`, and delegates execute, completion, inspection, and completeness requests to its remote worker. Worker messages include streams, rich display data, display updates, output clears, execution results/errors, and comms. This is substantial reusable protocol behavior. [Kernel host source](https://raw.githubusercontent.com/jupyterlite/pyodide-kernel/main/packages/pyodide-kernel/src/kernel.ts).

Running Pyodide without JupyterLab is directly documented: its Worker example accepts JavaScript messages, runs Python asynchronously, and returns correlated results. However that small example is an interpreter bridge, not a full notebook kernel implementation. [Pyodide Worker guide](https://pyodide.org/en/stable/usage/webworker.html).

**Inference, not integration proof:** reuse of the JupyterLite kernel/services packages beneath egui appears feasible without rendering the full JupyterLab interface. It still needs a custom bootstrap, asset configuration, message translation, lifecycle handling, and optional Contents implementation. The package depends on JupyterLab utilities and JupyterLite services; “without the shell” does not mean “without Jupyter JavaScript dependencies.” [Package manifest](https://raw.githubusercontent.com/jupyterlite/pyodide-kernel/main/packages/pyodide-kernel/package.json).

**Recommendation:** wrap that machinery behind the application's narrow kernel port. Preserve bounded snapshots and the same command gateway for human and tool calls; do not expose a general-purpose Jupyter forwarding API or copy Jupyter message objects directly into egui.

### Kernel execution and storage are different seams

JupyterLite explicitly distinguishes file-browser contents from an execution kernel's filesystem. Emscripten kernels can mount a `DriveFS` bridge, which routes filesystem operations to a Contents manager. Custom drives can therefore supply content independently of which language kernel executes code. [Contents architecture](https://jupyterlite.readthedocs.io/en/stable/reference/contents.html).

The synchronization bridge uses either `SharedArrayBuffer`/`Atomics.wait` or a Service Worker fallback. The first needs suitable COOP/COEP response headers. Without either functioning bridge, the kernel cannot access files listed in the file browser. [Filesystem synchronization requirements](https://jupyterlite.readthedocs.io/en/stable/howto/content/python.html).

The Pyodide worker's `mountDrive` option gates the custom filesystem mount; initialization of Python is a separate operation. [Worker source](https://raw.githubusercontent.com/jupyterlite/pyodide-kernel/main/packages/pyodide-kernel/src/worker.ts).

**Recommendation:** define a notebook store separately from kernel transport. Native storage can remain Jupyter Contents; browser storage can use a browser-backed store. Decide explicitly whether Python file reads/writes see that same store, an imported snapshot, or a temporary filesystem. Saving an `.ipynb` must not be confused with preserving a live Python heap. For a normal page-owned Worker, plan for reload to create a new runtime and lose live variables; test this lifecycle explicitly rather than promising reconnect parity with server kernels.

## Capability differences that must remain visible

| Area                                | Evidence                                                                                                                                                                                                                           | Design consequence / recommendation                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Python packages                     | Pyodide supports pure-Python wheels and compatible Emscripten/WASM binary wheels; remote wheel fetches require CORS. [Loading packages](https://pyodide.org/en/stable/usage/loading-packages.html)                                 | Do not promise arbitrary native `pip` environments. Test the actual course/package inventory.                                                          |
| OS and network behavior             | Pyodide documents limitations for threading, multiprocessing, sockets, several standard-library modules, and browser-mediated networking. [Python compatibility](https://pyodide.org/en/stable/usage/wasm-constraints.html)        | Native and browser variants need different capability declarations, not silent failures behind one label.                                              |
| Interrupt                           | Pyodide's live-code interrupt mechanism requires a Worker and shared interrupt buffer; the host signals through `setInterruptBuffer`. [Pyodide interrupts](https://pyodide.org/en/stable/usage/keyboard-interrupts.html)           | Expose true interrupt only after proving the selected kernel adapter wires it up.                                                                      |
| Queue cancellation versus interrupt | JupyterLite's changelog describes basic interrupt behavior that cancels queued cells but does not stop the running cell. [JupyterLite changelog](https://jupyterlite.readthedocs.io/en/latest/changelog.html?highlight=filesystem) | A visible interrupt button is not evidence of native interrupt parity. Distinguish queue cancellation, cooperative interrupt, and destructive restart. |
| Deployment assets                   | Pyodide assets default to a CDN; JupyterLite documents self-hosting and preparing package assets for offline use. [Offline deployment](https://jupyterlite.readthedocs.io/en/stable/howto/configure/advanced/offline.html)         | “Browser-only execution” does not automatically mean offline or zero-download. Pin and host a tested asset set.                                        |
| Collaboration                       | The official RTC page says there is no official JupyterLite RTC support and discusses decentralized browser content. [RTC status](https://jupyterlite.readthedocs.io/en/stable/howto/configure/rtc.html)                           | Do not infer that browser kernels inherit this repo's workspace-wide driver, session, or reconnect semantics.                                          |

Do not make a blanket claim that Pyodide packages cannot be preinstalled. The kernel project documents lockfile customization and compatible version families, while the offline guide covers packaging local assets. Package-loading details are release-dependent. [Pyodide-kernel README](https://github.com/jupyterlite/pyodide-kernel), [offline guide](https://jupyterlite.readthedocs.io/en/stable/howto/configure/advanced/offline.html).

## Julia is a separate feasibility question

The official Julia web-platform page characterizes browser/WASM work as early support and its native-dependency porting as experimental. The linked `Keno/julia-wasm` repository describes its implementation as an early alpha with known breakage. These are evidence of experiments, not proof of a production-equivalent browser IJulia kernel. [Julia web-platform projects](https://julialang.org/jsoc/gsoc/wasm/), [Julia WASM project](https://github.com/Keno/julia-wasm).

**Uncertainty:** this investigation did not establish a maintained browser Julia kernel matching the project's actual Julia notebooks and packages. Some linked Julia material is historical; it cannot prove that no newer implementation exists. **Recommendation:** retain native Julia as the supported path and treat browser Julia as a separately gated investigation. Successful compilation of selected Julia functions to WASM is not enough to establish a dynamic notebook kernel, package environment, filesystem bridge, display protocol, and interruption support.

## Rich output and widgets do not come free with the kernel

JupyterLab renders custom MIME output through frontend renderer plugins. Interactive widgets have both kernel-side state and frontend models/views linked by comm messages. Installing or reusing a Python kernel does not provide those frontend components to egui. [JupyterLab renderer architecture](https://jupyterlab.readthedocs.io/en/stable/extension/extension_dev.html#mime-renderer-plugins), [widget architecture](https://ipywidgets.readthedocs.io/en/stable/examples/Widget%20Low%20Level.html).

**Recommendation:** keep rendering as a separate capability. Preserve supported MIME data and replacement semantics in shared reducers; render only explicitly supported, bounded output in egui. A future DOM renderer bridge or widget manager would be a distinct feature and security decision, not an incidental consequence of browser execution. Widgets/comms are currently explicitly out of scope. [Local invariants](../../AGENTS.md).

## Proposed shared boundary, not a committed implementation plan

| Responsibility    | Shared pure Rust candidate                                                    | Host-specific responsibility                                             |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Notebook commands | Validation, deterministic authoritative transitions, revisions, idempotency   | Request delivery and identity/authority verification                     |
| Execution         | Scheduling policy, correlation, bounded output reducers, completion semantics | Native kernel WebSocket/REST adapter or JavaScript Worker adapter        |
| Notebook storage  | Canonical notebook model and save decisions                                   | Jupyter Contents versus browser store; optional kernel filesystem bridge |
| Collaboration     | Explicit authority/lease state transitions if genuinely portable              | Authentication, clocks, presence transport, reconnect, network fan-out   |
| Frontend          | Existing optimistic replica, protocol, egui                                   | Browser event handling and native/browser host bootstrap                 |

Keep the frontend optimistic replica distinct from authoritative runtime state even when both execute in one browser. Docker is deployment packaging for the native runtime, not an alternative kernel protocol. Neither recommendation requires moving Rust I/O into egui or broadening the public command API.

## Validation gates before any migration

1. Select and pin compatible kernel, Pyodide, JupyterLite services, and browser-bundler versions. The kernel README publishes compatibility families, and JupyterLite recently consolidated kernel/contents/session packages into `@jupyterlite/services`. [Compatibility](https://github.com/jupyterlite/pyodide-kernel), [migration guide](https://jupyterlite.readthedocs.io/en/stable/migration.html).
2. Prove one browser execution stream, error, `clear_output`, and `update_display_data` through the existing command path; verify no early finalization or out-of-order reconciliation.
3. Prove interruption versus queued cancellation, restart during execution, and reload/recovery without conflating saved notebook state and kernel variables.
4. Prove notebook save/reload and kernel file visibility independently, including no-SAB behavior, storage failures, and capability reporting.
5. Run representative package/notebook workloads in intended browsers; keep Julia and widgets unsupported until separately validated.
6. Only then decide whether shared Rust runtime extraction is worth the additional host/adapters. No migration, dependency update, or commit is authorized by this research note.

Source caveat: retrieved official stable pages and cached `main` source snapshots exposed different release labels. This investigation establishes architectural evidence, not a verified dependency lockfile. Exact current symbols, bundle sizes, and end-to-end compatibility must be checked against pinned source revisions during an explicitly authorized spike.
