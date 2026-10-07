#!/usr/bin/env bash
# Builds src/ts_rust.wasm from a ts-rust checkout.
#
#   TS_RUST_DIR  ts-rust checkout (required), for example a clone of pingdotgg/ts-rust
#   TOOLS_DIR    optional folder with rustup/, cargo/ and binaryen-*/bin (a toolchain kept outside the system)
#   WASM_OPT     set to "none" to skip wasm-opt (faster build, larger module)
#
# Needs Rust with the wasm32-wasip1 target and binaryen wasm-opt 132 or later on PATH.
set -euo pipefail

: "${TS_RUST_DIR:?set TS_RUST_DIR to a ts-rust checkout}"
repo_root=$(cd "$(dirname "$0")/.." && pwd)
out="$repo_root/src/ts_rust.wasm"

if [[ -n "${TOOLS_DIR:-}" ]]; then
  export RUSTUP_HOME="$TOOLS_DIR/rustup" CARGO_HOME="$TOOLS_DIR/cargo"
  binaryen=$(ls -d "$TOOLS_DIR"/binaryen-*/bin 2>/dev/null | head -n1 || true)
  export PATH="$TOOLS_DIR/cargo/bin${binaryen:+:$binaryen}:$PATH"
fi

# CI=1 makes the upstream script call plain cargo instead of its capped wrapper.
export CI=1
cd "$TS_RUST_DIR"
echo "building from $(git rev-parse --short HEAD 2>/dev/null || echo unknown) into $out"
scripts/wasm/build.sh "$out"
ls -l "$out"
