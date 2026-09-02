#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-up}" in
  up|prepare)
    mkdir -p .runtime/secrets .runtime/kernel-secrets "${DIDACTION_NOTEBOOK_WORKSPACE:-.runtime/notebooks}"
    token_file="${DIDACTION_JUPYTER_TOKEN_FILE:-.runtime/secrets/jupyter-token}"
    if [[ ! -f "$token_file" ]]; then
      (umask 077; openssl rand -hex 32 > "$token_file")
      chmod 700 .runtime/secrets
      chmod 444 "$token_file"
    fi
    if [[ "${1:-up}" == prepare ]]; then exit 0; fi
    if [[ "${DIDACTION_PREBUILT_FRONTEND:-0}" == 1 ]]; then
      pnpm build
      docker build --target gateway-prebuilt -t didaction-gateway:local .
      docker compose up --no-build -d
    else
      docker compose up --build -d
    fi
    echo "Notebook: http://127.0.0.1:${DIDACTION_PORT:-5173} (check docker compose ps for readiness)"
    ;;
  down) docker compose down ;;
  *) echo "Usage: bash scripts/container.sh [up|down|prepare]" >&2; exit 2 ;;
esac
