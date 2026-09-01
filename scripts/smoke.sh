#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

SMOKE_RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/didaction-smoke.XXXXXX")"
SMOKE_TOKEN="$(openssl rand -hex 24)"
SMOKE_NOTEBOOK="acceptance.ipynb"
mkdir -p "$SMOKE_RUNTIME/notebooks" "$SMOKE_RUNTIME/config" "$SMOKE_RUNTIME/data" "$SMOKE_RUNTIME/runtime"

export DIDACTION_JUPYTER_TOKEN="$SMOKE_TOKEN"
export TOKEN="$SMOKE_TOKEN"
export DIDACTION_NOTEBOOK_WORKSPACE="$SMOKE_RUNTIME/notebooks"
export DIDACTION_WORKSPACE="$SMOKE_RUNTIME/notebooks"
export DIDACTION_NOTEBOOK_PATH="$SMOKE_NOTEBOOK"
export DIDACTION_KERNEL_NAME="python3"
export DIDACTION_SMOKE_PATH="$SMOKE_NOTEBOOK"
export DIDACTION_JUPYTER_HOST="127.0.0.1"
export DIDACTION_JUPYTER_PORT="48888"
export DIDACTION_JUPYTER_URL="http://127.0.0.1:48888"
export DIDACTION_GATEWAY_URL="http://127.0.0.1:48080"
export JUPYTER_CONFIG_DIR="$SMOKE_RUNTIME/config"
export JUPYTER_DATA_DIR="$SMOKE_RUNTIME/data"
export JUPYTER_RUNTIME_DIR="$SMOKE_RUNTIME/runtime"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$SMOKE_RUNTIME"
}
trap cleanup EXIT INT TERM

uv run jupyter lab --config services/jupyter/jupyter_server_config.py \
  >"$SMOKE_RUNTIME/jupyter.log" 2>&1 & pids+=("$!")
uv run uvicorn services.gateway.app.main:app --host 127.0.0.1 --port 48080 \
  >"$SMOKE_RUNTIME/gateway.log" 2>&1 & pids+=("$!")

for _ in {1..80}; do
  if curl -fsS http://127.0.0.1:48080/readyz | grep -q '"status":"ready"'; then
    uv run python scripts/smoke.py
    exit 0
  fi
  sleep 0.25
done

tail -n 40 "$SMOKE_RUNTIME/jupyter.log" "$SMOKE_RUNTIME/gateway.log"
exit 1
