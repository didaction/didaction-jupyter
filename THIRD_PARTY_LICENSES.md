# Third-party distribution inventory

The repository's Apache-2.0 license applies only to original project material.
Dependencies, bundled fonts, upstream runtimes, container layers, imported
notebooks, datasets, and user content retain their own copyright and license terms.

This file records the reviewed runtime families distributed by the current source
tree. `Cargo.lock`, `pnpm-lock.yaml`, `uv.lock`, `deploy/xeus/explicit.lock`, and
`deploy/julia/Manifest.toml` are the exact transitive version inventories. Run
`pnpm audit:licenses` after installing locked dependencies; it fails when a resolved
Rust or production npm package lacks license metadata, a direct Python dependency
lacks license/source metadata, or a direct shipped component is absent below.

## Browser distribution

| Inventory key                         | Version | License      | Corresponding source                                            |
| ------------------------------------- | ------- | ------------ | --------------------------------------------------------------- |
| npm:@jupyterlite/pyodide-kernel       | 0.8.5   | BSD-3-Clause | <https://github.com/jupyterlite/pyodide-kernel/tree/v0.8.5>     |
| npm:@jupyterlite/pyodide-kernel-py312 | 0.6.1   | BSD-3-Clause | <https://github.com/jupyterlite/pyodide-kernel/tree/v0.6.1>     |
| npm:@jupyterlite/xeus                 | 5.0.0   | BSD-3-Clause | <https://github.com/jupyterlite/xeus/tree/v5.0.0>               |
| npm:assemblyscript                    | 0.28.9  | Apache-2.0   | <https://github.com/AssemblyScript/assemblyscript/tree/v0.28.9> |
| npm:pyodide                           | 314.0.5 | MPL-2.0      | <https://github.com/pyodide/pyodide/releases/tag/314.0.5>       |
| npm:pyodide-py312                     | 0.27.7  | MPL-2.0      | <https://github.com/pyodide/pyodide/tree/0.27.7>                |

The npm aliases identify the names in `package.json`; resolved upstream package
names remain in `pnpm-lock.yaml`. Pyodide's 314.x version line tracks its Python
3.14 ABI; the locked 314.0.5 package reports Python 3.14.2 and ABI `2026_0` in its
embedded lock data. Browser build tools may embed runtime support code, so a release
review must include any build package represented in emitted assets.

MPL-covered browser files remain available in corresponding-source form at the
exact links above and in the unmodified packages resolved by `pnpm-lock.yaml`.
Project modifications are maintained in this repository under their applicable
terms. A published static bundle must ship this inventory, the root `NOTICE`, and
the license files carried by its locked packages alongside the assets.

## Rust/WASM distribution

| Component              | Version | License                                             | Corresponding source                                                    |
| ---------------------- | ------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| egui / eframe / epaint | 0.32.3  | MIT OR Apache-2.0                                   | <https://github.com/emilk/egui/tree/0.32.3>                             |
| egui_code_editor       | 0.2.17  | MIT                                                 | <https://github.com/p4ymak/egui_code_editor/tree/0.2.17>                |
| egui_commonmark        | 0.21.0  | MIT OR Apache-2.0                                   | <https://github.com/lampsitter/egui_commonmark/tree/v0.21.0>            |
| Typst                  | 0.14.2  | Apache-2.0                                          | <https://github.com/typst/typst/tree/v0.14.2>                           |
| MiTeX                  | 0.2.4   | Apache-2.0                                          | <https://github.com/mitex-rs/mitex/tree/v0.2.4>                         |
| typst-as-lib           | 0.15.4  | MIT                                                 | <https://github.com/Relacibo/typst-as-lib/tree/v0.15.4>                 |
| option-ext             | 0.2.0   | MPL-2.0                                             | <https://github.com/soc/option-ext/tree/v0.2.0>                         |
| epaint_default_fonts   | 0.32.3  | (MIT OR Apache-2.0) AND OFL-1.1 AND Ubuntu-font-1.0 | <https://github.com/emilk/egui/tree/0.32.3/crates/epaint_default_fonts> |

`Cargo.lock` and Cargo package metadata are the complete Rust transitive inventory.
The audit verifies every resolved non-workspace package has a `license` expression
or `license-file`. Font licenses apply even when bytes arrive through a Rust crate.

## Server and container distribution

The following direct Python packages are fixed by `pyproject.toml`; `uv.lock` owns
their transitive versions. The audit also reads each installed distribution's
license and source metadata.

| Inventory key              | Version | License      | Corresponding source                                              |
| -------------------------- | ------- | ------------ | ----------------------------------------------------------------- |
| PyPI:fastapi               | 0.116.1 | MIT          | <https://github.com/fastapi/fastapi/tree/0.116.1>                 |
| PyPI:httpx                 | 0.28.1  | BSD-3-Clause | <https://github.com/encode/httpx/tree/0.28.1>                     |
| PyPI:ipykernel             | 6.30.1  | BSD-3-Clause | <https://github.com/ipython/ipykernel/tree/v6.30.1>               |
| PyPI:jupyter-collaboration | 4.0.2   | BSD-3-Clause | <https://github.com/jupyterlab/jupyter-collaboration/tree/v4.0.2> |
| PyPI:jupyter-kernel-client | 0.8.0   | BSD-3-Clause | <https://github.com/datalayer/jupyter-kernel-client/tree/0.8.0>   |
| PyPI:jupyter-server        | 2.21.0  | BSD-3-Clause | <https://github.com/jupyter-server/jupyter_server/tree/v2.21.0>   |
| PyPI:jupyterlab            | 4.4.5   | BSD-3-Clause | <https://github.com/jupyterlab/jupyterlab/tree/v4.4.5>            |
| PyPI:nbformat              | 5.10.4  | BSD-3-Clause | <https://github.com/jupyter/nbformat/tree/v5.10.4>                |
| PyPI:pip                   | 26.2.1  | MIT          | <https://github.com/pypa/pip/tree/26.2.1>                         |
| PyPI:pydantic              | 2.11.7  | MIT          | <https://github.com/pydantic/pydantic/tree/v2.11.7>               |
| PyPI:pydantic-settings     | 2.15.0  | MIT          | <https://github.com/pydantic/pydantic-settings/tree/v2.15.0>      |
| PyPI:uvicorn               | 0.35.0  | BSD-3-Clause | <https://github.com/encode/uvicorn/tree/0.35.0>                   |

The default container base is `quay.io/jupyter/minimal-notebook` pinned by digest in
`docker-compose.yml`; Jupyter Docker Stacks source and BSD-3-Clause terms are at
<https://github.com/jupyter/docker-stacks>. Optional Julia integration retains its
upstream license at [deploy/julia/LICENSE.upstream](deploy/julia/LICENSE.upstream).
The optional xeus environment's exact package inventory is
`deploy/xeus/explicit.lock`; its components retain their upstream terms.

## Distribution rules

1. Build only from committed lockfiles and retain their provenance with the artifact.
2. Include this file, `NOTICE`, and the full license/copyright files supplied by all
   packages and base-image layers in binary, static-site, and container releases.
3. Retain durable corresponding-source links for MPL-covered browser material and
   project modifications for as long as that version is distributed.
4. Keep third-party notebooks, images, and datasets under their original terms.
   Workspace import grants no redistribution right.
5. Run `pnpm audit:licenses` and review its complete resolved output whenever a
   lockfile, bundled font/runtime, base image, or packaging path changes. Automated
   metadata checks support—but do not replace—legal review of a release.

Authoritative license texts: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/),
[BSD-3-Clause](https://opensource.org/license/bsd-3-clause),
[MIT](https://opensource.org/license/mit), and
[SIL OFL-1.1](https://openfontlicense.org/).
