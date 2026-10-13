#!/usr/bin/env bash
# Cross-build the studio as a single file for Windows x64 and macOS arm64, from WSL or Linux.
# web/ is compiled into each one; see desktop/.
#
#   ./build-desktop.sh    writes dist/windows-x64/cart-studio.exe
#                         and    dist/macos-arm64/cart-studio, with first-run.sh beside it,
#                         and a README.txt in each folder
#   ./build-desktop.sh --slot-dir ../slot    use a different slot checkout
#
# Needs zig and cargo-zigbuild, which link for both targets without their SDKs:
#   https://ziglang.org/download/   and   cargo install --locked cargo-zigbuild
set -euo pipefail

slot_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --slot-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ] || [[ "$2" == --* ]]; then
        echo "build-desktop.sh: --slot-dir requires a directory" >&2
        exit 1
      fi
      slot_dir="$(cd -- "$2" 2>/dev/null && pwd -P)" || {
        echo "build-desktop.sh: slot directory does not exist: $2" >&2
        exit 1
      }
      slot_args=(--slot-dir "$slot_dir")
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./build-desktop.sh [--slot-dir PATH]"
      echo "PATH is relative to your current directory; defaults to ../slot-b beside the studio."
      exit 0
      ;;
    *) echo "build-desktop.sh: unknown option: $1; use --help" >&2; exit 1 ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")"

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

for tool in zig cargo-zigbuild; do
  command -v "$tool" >/dev/null || { echo "build-desktop.sh: $tool is not installed; see the top of this script" >&2; exit 1; }
done

# The WASM the binaries embed.
bash ./run.sh --build-only "${slot_args[@]}"

rustup target add x86_64-pc-windows-gnu aarch64-apple-darwin

# One folder per platform, each holding everything that platform needs.
rm -rf dist
build() {
  local target="$1" built="$2" folder="$3"
  cargo zigbuild --release --manifest-path desktop/Cargo.toml --target "$target"
  mkdir -p "dist/$folder"
  cp "${CARGO_TARGET_DIR:-desktop/target}/$target/release/$built" "dist/$folder/"
}
build x86_64-pc-windows-gnu cart-studio.exe windows-x64
build aarch64-apple-darwin  cart-studio     macos-arm64

# The Mac build is not signed with an Apple Developer ID, so a copy that was downloaded is
# quarantined and macOS calls it damaged. This clears that on the Mac it landed on. It is run
# through sh, which reads it, so its own quarantine does not matter.
cat > dist/macos-arm64/first-run.sh <<'EOF'
#!/bin/sh
# Run once after copying this folder to a Mac:   sh first-run.sh
# macOS reports a downloaded cart-studio as damaged until this has been run.
set -e
cd "$(dirname "$0")"
xattr -d com.apple.quarantine cart-studio 2>/dev/null || true
chmod +x cart-studio
codesign --force --sign - cart-studio
echo "Done. Starting Cart Studio; next time run ./cart-studio directly."
exec ./cart-studio
EOF
chmod +x dist/macos-arm64/first-run.sh

# What to do with each folder, for whoever it is copied to.
cat > dist/macos-arm64/README.txt <<'EOF'
Cart Studio for macOS (Apple Silicon)

1. Copy this folder anywhere on the Mac.
2. Open Terminal in the folder and run, once:

       sh first-run.sh

   macOS reports a downloaded copy as damaged until this has been run.
3. After that, start it with:

       ./cart-studio

The studio opens in your default browser. Close the Terminal window to stop it.
To use a local artwork collection: ./cart-studio --art-dir /path/to/artwork
The collection directory must contain index.json and its prepared PNGs.
It needs the internet for game names, artwork, and album cover searches. Use Chrome
or Edge to write labels and covers straight to the SD card; other browsers download
a zip instead. Unzip at the card root and merge Games and Labels.
EOF
cat > dist/windows-x64/README.txt <<'EOF'
Cart Studio for Windows (64-bit)

1. Copy this folder anywhere on the PC.
2. Double-click cart-studio.exe.
   If Windows warns about an unknown publisher, choose More info, then Run anyway.

The studio opens in your default browser. Close the console window to stop it.
To use local artwork, run: cart-studio.exe --art-dir "C:\path\to\artwork"
The collection directory must contain index.json and its prepared PNGs.
It needs the internet for game names, artwork, and album cover searches. Use Chrome
or Edge to write labels and covers straight to the SD card; other browsers download
a zip instead. Unzip at the card root and merge Games and Labels.
EOF
# Notepad wants Windows line endings.
sed -i 's/$/\r/' dist/windows-x64/README.txt

# zig leaves this behind in the directory it was run from.
rm -f .intentionally-empty-file.o

ls -l dist/*
