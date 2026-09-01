#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .runtime/notebooks .runtime/jupyter-config .runtime/jupyter-data .runtime/jupyter-runtime
DIDACTION_DEV_TOKEN="${DIDACTION_JUPYTER_TOKEN:-$(openssl rand -hex 24)}"
export DIDACTION_JUPYTER_TOKEN="$DIDACTION_DEV_TOKEN"
export TOKEN="$DIDACTION_DEV_TOKEN"
export DIDACTION_NOTEBOOK_WORKSPACE="${DIDACTION_NOTEBOOK_WORKSPACE:-$PWD/.runtime/notebooks}"
export JUPYTER_CONFIG_DIR="$PWD/.runtime/jupyter-config"
export JUPYTER_DATA_DIR="$PWD/.runtime/jupyter-data"
export JUPYTER_RUNTIME_DIR="$PWD/.runtime/jupyter-runtime"

pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

uv run jupyter lab --config services/jupyter/jupyter_server_config.py & pids+=("$!")
uv run mcp-jupyter --transport http --host 127.0.0.1 --port 8090 & pids+=("$!")
uv run uvicorn services.gateway.app.main:app --host 127.0.0.1 --port 8080 & pids+=("$!")
pnpm run dev & pids+=("$!")

echo "didaction notebook: http://127.0.0.1:5173"
echo "Services are loopback-only. The generated Jupyter token is intentionally not printed."
wait
