#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo check --workspace --target wasm32-unknown-unknown
pnpm run format
pnpm run typecheck
pnpm test
uv run ruff format --check services scripts tests
uv run ruff check services scripts tests
uv run mypy
uv run pytest -q
uv run python scripts/discover_mcp.py
pnpm run build
pnpm run test:browser
scripts/smoke.sh
