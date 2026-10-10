#!/usr/bin/env bash
# Cross-build the studio as a single file for Windows x64 and macOS arm64, from WSL or Linux.
# web/ is compiled into each one; see desktop/.
#
#   ./build-desktop.sh    writes dist/slot-cart-studio-windows-x64.exe
#                         and    dist/slot-cart-studio-macos-arm64
#
# Needs zig and cargo-zigbuild, which link for both targets without their SDKs:
#   https://ziglang.org/download/   and   cargo install --locked cargo-zigbuild
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

for tool in zig cargo-zigbuild; do
  command -v "$tool" >/dev/null || { echo "build-desktop.sh: $tool is not installed; see the top of this script" >&2; exit 1; }
done

# The WASM the binaries embed.
./run.sh --build-only

rustup target add x86_64-pc-windows-gnu aarch64-apple-darwin

mkdir -p dist
build() {
  local target="$1" built="$2" out="$3"
  cargo zigbuild --release --manifest-path desktop/Cargo.toml --target "$target"
  cp "desktop/target/$target/release/$built" "dist/$out"
}
build x86_64-pc-windows-gnu slot-cart-studio.exe slot-cart-studio-windows-x64.exe
build aarch64-apple-darwin  slot-cart-studio     slot-cart-studio-macos-arm64

# zig leaves this behind in the directory it was run from.
rm -f .intentionally-empty-file.o

ls -l dist
