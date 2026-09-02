#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DIDACTION_NOTEBOOK_WORKSPACE="${DIDACTION_NOTEBOOK_WORKSPACE:-$(cd ../summer-quantum-school26 && pwd)}"
export DIDACTION_NOTEBOOK_PATH="${DIDACTION_NOTEBOOK_PATH:-QS_DAY1_Lab_participants.ipynb}"
export DIDACTION_KERNEL_NAME=python3
export DIDACTION_RUNTIME_IMAGE=localhost/didaction-quantum-school:local
case "${1:-up}" in
  up)
    docker build -f deploy/Dockerfile.quantum-school -t "$DIDACTION_RUNTIME_IMAGE" deploy
    bash scripts/container.sh prepare
    docker compose down
    docker compose up --no-build -d
    echo "Quantum school: http://127.0.0.1:${DIDACTION_PORT:-5173}"
    ;;
  down) bash scripts/container.sh down ;;
  *) echo "Usage: bash scripts/quantum-school.sh [up|down]" >&2; exit 2 ;;
esac
