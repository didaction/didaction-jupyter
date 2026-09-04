# Contributing

Thanks for improving didaction Jupyter. The project targets familiar notebook
behavior for researchers, students, and learners while keeping one validated
command path across egui and WebMCP.

## Before changing code

Read [AGENTS.md](AGENTS.md), the [documentation index](docs/README.md), and the
[frontend parity matrix](docs/frontend-parity.md). For Microscope authoring or
graphics, also read [SKILLS.md](SKILLS.md).

Open an issue before a large protocol, security-boundary, storage-format, or UX
direction change. Small fixes and tests can go directly to a focused pull request.
Do not commit notebook outputs, tokens, runtime directories, imported datasets, or
third-party course material without clear redistribution rights.

## Development setup

Use the versions pinned by `rust-toolchain.toml`, `uv.lock`, `pnpm-lock.yaml`, and
`Cargo.lock`.

```bash
uv sync --python 3.12 --frozen
pnpm install --frozen-lockfile
rustup target add wasm32-unknown-unknown
pnpm build:wasm
```

Run the server development environment with `scripts/dev.sh`, or build the static
browser runtime with `pnpm build:browser && pnpm serve:browser`.

## Change expectations

- Preserve the single typed command path. Human UI and WebMCP must not implement
  independent notebook mutation logic.
- Keep credentials and Jupyter connection details outside browser-visible state.
- Add or update tests at the layer that owns the behavior.
- Update the current documentation and parity matrix when capability changes.
- Keep commits focused and explain user-visible behavior in the pull request.
- Add third-party dependency or asset licensing information in
  `THIRD_PARTY_LICENSES.md`; run `pnpm audit:licenses` before distribution changes.

## Verification

Run focused tests while iterating, then run the complete suite before requesting
review:

```bash
scripts/check.sh
```

CI separates fast Rust/TypeScript/Python checks from browser-local and real-kernel
acceptance. A pull request is ready when all applicable jobs pass, its documentation
matches observed behavior, and security-sensitive changes describe their trust
boundary.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
