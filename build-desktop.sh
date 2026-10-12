#!/usr/bin/env bash
# Cross-build the studio as a single file for Windows x64 and macOS arm64, from WSL or Linux.
# web/ is compiled into each one; see desktop/.
#
#   ./build-desktop.sh    writes dist/windows-x64/slot-cart-studio.exe
#                         and    dist/macos-arm64/slot-cart-studio, with first-run.sh beside it,
#                         and a README.txt in each folder
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

# One folder per platform, each holding everything that platform needs.
rm -rf dist
build() {
  local target="$1" built="$2" folder="$3"
  cargo zigbuild --release --manifest-path desktop/Cargo.toml --target "$target"
  mkdir -p "dist/$folder"
  cp "${CARGO_TARGET_DIR:-desktop/target}/$target/release/$built" "dist/$folder/"
}
build x86_64-pc-windows-gnu slot-cart-studio.exe windows-x64
build aarch64-apple-darwin  slot-cart-studio     macos-arm64

# The Mac build is not signed with an Apple Developer ID, so a copy that was downloaded is
# quarantined and macOS calls it damaged. This clears that on the Mac it landed on. It is run
# through sh, which reads it, so its own quarantine does not matter.
cat > dist/macos-arm64/first-run.sh <<'EOF'
#!/bin/sh
# Run once after copying this folder to a Mac:   sh first-run.sh
# macOS reports a downloaded slot-cart-studio as damaged until this has been run.
set -e
cd "$(dirname "$0")"
xattr -d com.apple.quarantine slot-cart-studio 2>/dev/null || true
chmod +x slot-cart-studio
codesign --force --sign - slot-cart-studio
echo "Done. Starting Cart Studio; next time run ./slot-cart-studio directly."
exec ./slot-cart-studio
EOF
chmod +x dist/macos-arm64/first-run.sh

# What to do with each folder, for whoever it is copied to.
cat > dist/macos-arm64/README.txt <<'EOF'
slot cart studio for macOS (Apple Silicon)

1. Copy this folder anywhere on the Mac.
2. Open Terminal in the folder and run, once:

       sh first-run.sh

   macOS reports a downloaded copy as damaged until this has been run.
3. After that, start it with:

       ./slot-cart-studio

The studio opens in your default browser. Close the Terminal window to stop it.
It needs the internet for game names, artwork, and album cover searches. Use Chrome
or Edge to write labels and covers straight to the SD card; other browsers download
a zip instead. Unzip at the card root and merge Games and Labels.
EOF
cat > dist/windows-x64/README.txt <<'EOF'
slot cart studio for Windows (64-bit)

1. Copy this folder anywhere on the PC.
2. Double-click slot-cart-studio.exe.
   If Windows warns about an unknown publisher, choose More info, then Run anyway.

The studio opens in your default browser. Close the console window to stop it.
It needs the internet for game names, artwork, and album cover searches. Use Chrome
or Edge to write labels and covers straight to the SD card; other browsers download
a zip instead. Unzip at the card root and merge Games and Labels.
EOF
# Notepad wants Windows line endings.
sed -i 's/$/\r/' dist/windows-x64/README.txt

# zig leaves this behind in the directory it was run from.
rm -f .intentionally-empty-file.o

ls -l dist/*
