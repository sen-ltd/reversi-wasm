#!/usr/bin/env bash
#
# Build reversi.wasm and place it under assets/ so the HTML page can
# fetch('./assets/reversi.wasm'). Runs in a throwaway Docker container so
# the host doesn't need a Rust toolchain.

set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${RUST_IMAGE:-rust:1.90-alpine}"
TARGET_DIR="rust/target/wasm32-unknown-unknown/release"

docker run --rm \
  -v "$PWD/rust:/work" \
  -w /work \
  -e CARGO_TARGET_DIR=/work/target \
  "$IMAGE" sh -c "
    rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
    cargo build --release --target wasm32-unknown-unknown
  "

mkdir -p assets
cp "$TARGET_DIR/reversi_wasm.wasm" assets/reversi.wasm
ls -la assets/reversi.wasm
