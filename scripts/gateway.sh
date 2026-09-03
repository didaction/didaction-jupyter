#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${DIDACTION_GATEWAY_IMPLEMENTATION:-rust}" in
  rust)
    cargo build --locked -p notebook-gateway
    exec target/debug/notebook-gateway
    ;;
  python) exec uv run uvicorn services.gateway.app.main:app --host 127.0.0.1 --port "${DIDACTION_GATEWAY_PORT:-8080}" --no-access-log ;;
  *) echo "Choose DIDACTION_GATEWAY_IMPLEMENTATION=python or rust" >&2; exit 2 ;;
esac
