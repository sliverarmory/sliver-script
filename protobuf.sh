#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$#" -eq 0 ]]; then
  set -- --write
fi

exec node "${ROOT_DIR}/scripts/protobuf.mjs" "$@"
