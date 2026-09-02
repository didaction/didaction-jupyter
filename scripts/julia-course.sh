#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DIDACTION_NOTEBOOK_WORKSPACE="${DIDACTION_NOTEBOOK_WORKSPACE:-$PWD/.runtime/control-systems-course}"
export DIDACTION_NOTEBOOK_PATH="${DIDACTION_NOTEBOOK_PATH:-mcs_problem_class1.ipynb}"
export DIDACTION_KERNEL_NAME=julia-course-1.10
export DIDACTION_RUNTIME_IMAGE=localhost/didaction-julia:local
export DIDACTION_PORT="${DIDACTION_PORT:-5174}"
case "${1:-up}" in
  up|prepare)
    if [[ ! -e "$DIDACTION_NOTEBOOK_WORKSPACE" ]]; then
      git clone --no-checkout https://github.com/KIT-MRT/control_systems_lecture_content.git "$DIDACTION_NOTEBOOK_WORKSPACE"
      git -C "$DIDACTION_NOTEBOOK_WORKSPACE" checkout f64a9acdca64e9e5e09db2fe13867c21de17dd76
    fi
    if [[ ! -f "$DIDACTION_NOTEBOOK_WORKSPACE/$DIDACTION_NOTEBOOK_PATH" ]]; then
      echo "Notebook missing from the configured folder; existing folders are never overwritten." >&2
      exit 1
    fi
    bash scripts/container.sh prepare
    if [[ "${1:-up}" == prepare ]]; then exit 0; fi
    docker build -f deploy/Dockerfile.julia -t "$DIDACTION_RUNTIME_IMAGE" deploy
    docker compose -p didaction-julia up --no-build -d
    echo "Julia course: http://127.0.0.1:$DIDACTION_PORT"
    ;;
  down) docker compose -p didaction-julia down ;;
  *) echo "Usage: bash scripts/julia-course.sh [up|prepare|down]" >&2; exit 2 ;;
esac
