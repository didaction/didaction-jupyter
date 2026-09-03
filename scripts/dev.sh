#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .runtime/notebooks .runtime/jupyter-config .runtime/jupyter-data .runtime/jupyter-runtime
DIDACTION_DEV_TOKEN="${DIDACTION_JUPYTER_TOKEN:-$(openssl rand -hex 24)}"
export DIDACTION_JUPYTER_TOKEN="$DIDACTION_DEV_TOKEN"
export TOKEN="$DIDACTION_DEV_TOKEN"
export DIDACTION_NOTEBOOK_WORKSPACE="${DIDACTION_NOTEBOOK_WORKSPACE:-$PWD/.runtime/notebooks}"
export DIDACTION_WORKSPACE="$DIDACTION_NOTEBOOK_WORKSPACE"
export DIDACTION_NOTEBOOK_PATH="${DIDACTION_NOTEBOOK_PATH:-notebook-parity-demo.ipynb}"
export DIDACTION_KERNEL_NAME="${DIDACTION_KERNEL_NAME:-python3}"
export JUPYTER_CONFIG_DIR="$PWD/.runtime/jupyter-config"
export JUPYTER_DATA_DIR="$PWD/.runtime/jupyter-data"
export JUPYTER_RUNTIME_DIR="$PWD/.runtime/jupyter-runtime"

if [[ -n "${DIDACTION_KERNEL_PYTHON:-}" ]]; then
  if [[ ! "$DIDACTION_KERNEL_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "DIDACTION_KERNEL_NAME contains unsupported characters" >&2
    exit 2
  fi
  if [[ ! -x "$DIDACTION_KERNEL_PYTHON" ]]; then
    echo "DIDACTION_KERNEL_PYTHON is not an executable file" >&2
    exit 2
  fi
  DIDACTION_KERNEL_PREFIX="$PWD/.runtime/kernel-prefix"
  "$DIDACTION_KERNEL_PYTHON" -m ipykernel install \
    --prefix "$DIDACTION_KERNEL_PREFIX" \
    --name "$DIDACTION_KERNEL_NAME" \
    --display-name "$DIDACTION_KERNEL_NAME" >/dev/null
  export JUPYTER_PATH="$DIDACTION_KERNEL_PREFIX/share/jupyter${JUPYTER_PATH:+:$JUPYTER_PATH}"
fi

pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

uv run jupyter lab --config services/jupyter/jupyter_server_config.py & pids+=("$!")
bash scripts/gateway.sh & pids+=("$!")
pnpm run dev & pids+=("$!")

echo "didaction notebook: http://127.0.0.1:5173"
echo "Services are loopback-only. The generated Jupyter token is intentionally not printed."
wait
