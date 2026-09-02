#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .runtime
check_dir="$(mktemp -d "$PWD/.runtime/container-check.XXXXXX")"
export DIDACTION_NOTEBOOK_WORKSPACE="$check_dir/notebooks"
export DIDACTION_JUPYTER_TOKEN_FILE="$check_dir/token"
export DIDACTION_NOTEBOOK_PATH=acceptance.ipynb
export DIDACTION_KERNEL_NAME=python3
export DIDACTION_PORT=45173
export DIDACTION_GATEWAY_URL=http://127.0.0.1:45173
export DIDACTION_SMOKE_PATH=acceptance.ipynb
cleanup() {
  docker compose -p didaction-check down
  if [[ "$check_dir" == "$PWD/.runtime/container-check."* ]]; then rm -rf "$check_dir"; fi
}
trap cleanup EXIT
bash scripts/container.sh prepare
docker compose -p didaction-check up --no-build -d
for attempt in {1..90}; do
  if curl -fsS "$DIDACTION_GATEWAY_URL/readyz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$DIDACTION_GATEWAY_URL/readyz"
uv run python scripts/smoke.py
curl -fsS "$DIDACTION_GATEWAY_URL/api/v1/download" >/dev/null
node scripts/container-browser.mjs
DIDACTION_BROWSER_GATEWAY="$DIDACTION_GATEWAY_URL" pnpm exec playwright test tests/browser/tools.spec.ts tests/browser/explorer.spec.ts tests/browser/collaboration.spec.ts tests/browser/follow.spec.ts --workers=1
