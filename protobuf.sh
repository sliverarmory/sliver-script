#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEFAULT_IN_DIR="${ROOT_DIR}/sliver/protobuf"
# If a full Sliver checkout exists next to this repo, prefer it (it is easier to keep up to date)
# while still allowing explicit overrides via SLIVER_PROTO_ROOT.
if [[ -d "${ROOT_DIR}/../sliver/protobuf" ]]; then
  DEFAULT_IN_DIR="${ROOT_DIR}/../sliver/protobuf"
fi
IN_DIR="${SLIVER_PROTO_ROOT:-${DEFAULT_IN_DIR}}"
OUT_DIR="${ROOT_DIR}/src/pb"

TS_PROTO_PLUGIN="${ROOT_DIR}/node_modules/.bin/protoc-gen-ts_proto"

if [[ ! -d "${IN_DIR}" ]]; then
  echo "Missing protobuf input directory: ${IN_DIR}"
  echo "Set SLIVER_PROTO_ROOT to override the default."
  exit 1
fi

if [[ ! -x "${TS_PROTO_PLUGIN}" ]]; then
  echo "Missing ${TS_PROTO_PLUGIN}"
  echo "Run: npm install"
  exit 1
fi

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

# We compile against the Sliver protobufs checked into ./sliver (submodule).
# Do not write anything into ./sliver; it is treated as read-only input.
PROTO_FILES=(
  "commonpb/common.proto"
  "clientpb/client.proto"
  "sliverpb/sliver.proto"
  "rpcpb/services.proto"
  "dnspb/dns.proto"
)

protoc \
  -I "${IN_DIR}" \
  --plugin="protoc-gen-ts_proto=${TS_PROTO_PLUGIN}" \
  --ts_proto_out="${OUT_DIR}" \
  --ts_proto_opt="env=node,esModuleInterop=true,forceLong=string,useExactTypes=false,useOptionals=messages,outputServices=nice-grpc,outputServices=generic-definitions" \
  "${PROTO_FILES[@]}"
