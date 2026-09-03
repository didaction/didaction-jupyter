#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .runtime
native_check_dir="$(mktemp -d "$PWD/.runtime/native-container-check.XXXXXX")"
export DIDACTION_NOTEBOOK_WORKSPACE="$native_check_dir/notebooks"
export DIDACTION_JUPYTER_TOKEN_FILE="$native_check_dir/token"
export DIDACTION_NOTEBOOK_PATH=native-julia.ipynb
export DIDACTION_KERNEL_NAME=julia-course-1.10
export DIDACTION_RUNTIME_IMAGE=localhost/didaction-julia:local
export DIDACTION_PORT=45175
export DIDACTION_GATEWAY_URL=http://127.0.0.1:45175
compose=(docker compose -p didaction-native-check -f docker-compose.yml -f deploy/compose.rust.yml)
cleanup() {
  "${compose[@]}" down
  if [[ "$native_check_dir" == "$PWD/.runtime/native-container-check."* ]]; then
    rm -rf "$native_check_dir"
  fi
}
trap cleanup EXIT
bash scripts/container.sh prepare
"${compose[@]}" up --no-build -d
for _ in {1..120}; do
  if curl -fsS "$DIDACTION_GATEWAY_URL/readyz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$DIDACTION_GATEWAY_URL/readyz" >/dev/null
uv run python scripts/native-julia-smoke.py
node scripts/container-browser.mjs
