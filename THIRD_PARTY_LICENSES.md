# Third-party licenses

The Apache-2.0 license at the repository root applies to original project
material, unless a file states otherwise. It does not relicense dependencies,
bundled fonts, upstream source, imported notebooks, datasets, or user content.
Retain the copyright and license notices supplied by their respective authors.

## Identified components

This starting inventory is based on the resolved Cargo metadata and installed
npm package metadata. It is **not a complete distribution license manifest**.
Lockfiles identify versions, but do not replace license texts or attribution.

| Component                  | Version | Declared license                                    |
| -------------------------- | ------- | --------------------------------------------------- |
| egui / eframe              | 0.32.3  | MIT OR Apache-2.0                                   |
| egui_code_editor           | 0.2.17  | MIT                                                 |
| egui_commonmark            | 0.21.0  | MIT OR Apache-2.0                                   |
| Typst                      | 0.14.2  | Apache-2.0                                          |
| MiTeX                      | 0.2.4   | Apache-2.0                                          |
| typst-as-lib               | 0.15.4  | MIT                                                 |
| JupyterLite Pyodide kernel | 0.8.5   | BSD-3-Clause                                        |
| Pyodide                    | 314.0.5 | MPL-2.0                                             |
| AssemblyScript             | 0.28.9  | Apache-2.0                                          |
| option-ext                 | 0.2.0   | MPL-2.0                                             |
| epaint_default_fonts       | 0.32.3  | (MIT OR Apache-2.0) AND OFL-1.1 AND Ubuntu-font-1.0 |

`OR` licenses offer a choice; `AND` means the additional licenses also apply.
Fonts embedded through Typst must also be checked against their upstream notices.
The upstream notice for the Julia deployment integration is retained separately
in [deploy/julia/LICENSE.upstream](deploy/julia/LICENSE.upstream).

## Distribution checklist

Before publishing browser assets, binaries, or container images:

1. Inventory the actual shipped dependencies, including transitive Rust/npm
   components, bundled Python wheels and standard library, fonts, and container
   packages. Distinguish build tools from code embedded in the resulting artifact.
2. Include their applicable full license texts, copyright notices and required
   upstream NOTICE material. Preserve notices when minifying or bundling.
3. For MPL-covered executable material, inform recipients how to obtain the
   corresponding covered source, including modifications, under MPL. Provide
   durable references to the exact distributed version; retain build provenance.
   Browser-delivered JavaScript/WASM is distribution, not merely server-side use.
4. Keep third-party course notebooks, images and datasets under their original
   terms. Importing content into a workspace does not grant redistribution rights.
5. Repeat the audit when dependencies or packaging change. Publishing this
   inventory does not, by itself, complete those distribution obligations.

Authoritative references: [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/),
[SIL Open Font License](https://openfontlicense.org/).
