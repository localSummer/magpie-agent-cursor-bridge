#!/bin/bash
set -euo pipefail
bridge_package="$(cd -- "$(dirname -- "$0")/.." && pwd)"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This build script supports macOS Apple Silicon only.' >&2
  exit 1
fi
bridge_build="$(mktemp -d "${TMPDIR:-/tmp}/cursor-bridge-build.XXXXXX")"
trap 'rm -rf -- "$bridge_build"' EXIT
# CURSOR_BRIDGE_SOURCE skips network access; its HEAD must match the pinned
# upstream commit. The helper clones committed data into this private directory.
node "$bridge_package/lib/native-build.js" prepare "$bridge_package" "$bridge_build/source"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export CARGO_TARGET_DIR="$bridge_build/target"
export CURSOR_BYOK_DATA_DIR="$bridge_build/data"
cargo test --manifest-path "$bridge_build/source/Cargo.toml" --locked -p cursor-server --lib
cargo test --manifest-path "$bridge_build/source/Cargo.toml" --locked -p cursor-server --test commit_message
cargo test --manifest-path "$bridge_build/source/Cargo.toml" --locked -p cursor-server --test error_lifecycle
cargo test --manifest-path "$bridge_build/source/Cargo.toml" --locked -p cursor-server --test bridge_policy
cargo test --manifest-path "$bridge_build/source/Cargo.toml" --locked -p cursor-server --bin cursor-magpie-bridge
cargo build --manifest-path "$bridge_build/source/Cargo.toml" --release --locked -p cursor-server --bin cursor-magpie-bridge
# Validation and digest generation use a private candidate. A failed version
# check leaves the shipped binary and integrity manifest untouched.
node "$bridge_package/lib/native-build.js" publish "$bridge_package" "$CARGO_TARGET_DIR/release/cursor-magpie-bridge"
