# Julia control-systems course

The runtime extends the pinned Jupyter minimal-notebook image with Julia 1.10.10
and the package environment from
[KIT-MRT/control_systems_lecture_base](https://github.com/KIT-MRT/control_systems_lecture_base)
at `889b7ebc4d15f62d4de23680689e5b32ee64f378`.
`deploy/julia/Project.toml` preserves its dependency list;
`deploy/julia/Manifest.toml` locks the resolved packages. The upstream BSD license
is included alongside them. This is not the upstream Binder image verbatim:
Jupyter comes from our existing runtime image, Julia is pinned, and package
versions are resolved and locked rather than floating.

```bash
pnpm build
docker build --target gateway-prebuilt -t didaction-gateway:local .
bash scripts/julia-course.sh up
# Execute the first nine code cells and verify three static plots (changes outputs):
uv run python scripts/julia-smoke.py
# Stop this deployment only:
bash scripts/julia-course.sh down
```

The script uses Compose project `didaction-julia` on port 5174; the default
deployment on 5173 is not stopped. Course files live in
`.runtime/control-systems-course`. Existing folders are never reset or
overwritten. The initial checkout is pinned to content commit
`f64a9acdca64e9e5e09db2fe13867c21de17dd76`, opening
`mcs_problem_class1.ipynb`. Use the Files explorer to open the other notebooks.
Override `DIDACTION_NOTEBOOK_WORKSPACE`, `DIDACTION_NOTEBOOK_PATH`, or
`DIDACTION_PORT` at launch. The configured kernel is `julia-course-1.10`.

First builds download substantial Julia packages and may take several minutes.
This development kernel uses `--compiled-modules=no`, `-O0`, and a 600 MB GC heap
hint to avoid parallel package precompilation exhausting small VMs. A cold
course-library import took about 90 seconds in our test; Julia cell execution
has a bounded 120-second UI timeout. WebMCP callers can pass `timeout_ms: 120000`.
The heap hint is not a hard memory/security limit.
Docker's kernel memory limit remains independently configurable. For scientific
performance, use a larger VM and change the optimization setting deliberately,
then rebuild and reverify. The original notebook metadata records Julia 1.8.1;
this runtime uses Julia 1.10.10, so compatibility is tested rather than assumed.

## Display limitations

Julia text, errors, and static PNG/SVG plots use the ordinary Jupyter protocol
and egui renderer. The notebook's `Interact.@manipulate` cells require WebIO and
browser-side JavaScript/widget support that egui does not implement. Installing
Interact in the kernel does not provide those sliders. Run the ordinary setup
and plotting cells; for a static convolution view call
`plot_convolution(u, g1, y1, 5.0, plot_t)` after defining its arguments.
The original course source is not rewritten to pretend widget support exists.

Verified locally: all first nine original code cells execute, producing three
static plots. The basis-signal plot was also captured from the actual egui canvas
through WebMCP after a browser reload. The remaining interactive exercise cells
were not claimed as supported or executed by the smoke test.

To upgrade, review the upstream Project changes, resolve a new Manifest using
the pinned Julia runtime, rebuild, and verify real kernel imports and plots.
Do not run `Pkg.update()` at service startup.
