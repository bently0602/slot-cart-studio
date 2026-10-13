#!/usr/bin/env bash
# Build the studio's WASM into web/pkg and serve web/ on localhost, from WSL.
#
#   ./run.sh              build, then serve at http://127.0.0.1:8765
#   ./run.sh --build-only build and stop
#   ./run.sh --slot-dir ../slot    use a different slot checkout
#   PORT=9000 ./run.sh    serve somewhere else
set -euo pipefail

build_only=false
slot_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only) build_only=true; shift ;;
    --slot-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ] || [[ "$2" == --* ]]; then
        echo "run.sh: --slot-dir requires a directory" >&2
        exit 1
      fi
      slot_dir="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./run.sh [--build-only] [--slot-dir PATH]"
      echo "PATH is relative to your current directory; defaults to ../slot-b beside the studio."
      exit 0
      ;;
    *) echo "run.sh: unknown option: $1; use --help" >&2; exit 1 ;;
  esac
done

# Resolve an explicit path before changing to the studio directory.
if [ -n "$slot_dir" ]; then
  SLOT="$(cd -- "$slot_dir" 2>/dev/null && pwd -P)" || {
    echo "run.sh: slot directory does not exist: $slot_dir" >&2
    exit 1
  }
fi
cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-8765}"
WASM_PACK_VERSION=0.15.0
if [ -z "$slot_dir" ]; then
  SLOT=../slot-b
fi

# Check the checkout before installing tools or building assets.
if [ ! -f "$SLOT/crates/slot-ui/Cargo.toml" ] || [ ! -f "$SLOT/crates/slot-store/Cargo.toml" ]; then
  echo "run.sh: no slot checkout at $SLOT; use --slot-dir PATH to select the slot fork" >&2
  exit 1
fi

# Non-login shells do not always have cargo's bin on PATH.
export PATH="$HOME/.cargo/bin:$PATH"

for tool in cargo python3 git node npm; do
  command -v "$tool" >/dev/null || { echo "run.sh: $tool is not installed in WSL" >&2; exit 1; }
done

# The same prebuilt wasm-pack the pages workflow uses.
if ! command -v wasm-pack >/dev/null; then
  echo "run.sh: installing wasm-pack $WASM_PACK_VERSION into ~/.cargo/bin"
  name="wasm-pack-v$WASM_PACK_VERSION-$(uname -m)-unknown-linux-musl"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/wasm-bindgen/wasm-pack/releases/download/v$WASM_PACK_VERSION/$name.tar.gz" \
    | tar -xz -C "$tmp"
  install -m 755 "$tmp/$name/wasm-pack" "$HOME/.cargo/bin/wasm-pack"
  rm -rf "$tmp"
fi

# The build compiles slot's own sources from the selected checkout.
pin="$(cat slot.ref)"
head="$(git -C "$SLOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$head" != "$pin" ]; then
  echo "run.sh: warning: $SLOT is at ${head:0:7}, slot.ref pins ${pin:0:7}; faces may differ from the deployed studio" >&2
fi

npm ci
npm run build
if [ -n "$slot_dir" ]; then
  # Cargo paths and Rust #[path] imports expect a sibling called slot-b. Give them
  # that layout in a temporary source tree, without changing either checkout.
  build_dir="$(mktemp -d)"
  trap 'rm -rf -- "$build_dir"' EXIT
  mkdir "$build_dir/studio"
  cp -R Cargo.toml Cargo.lock rust-toolchain.toml src shim tests "$build_dir/studio/"
  ln -s -- "$SLOT" "$build_dir/slot-b"
  target_dir="${CARGO_TARGET_DIR:-$PWD/target}"
  [[ "$target_dir" == /* ]] || target_dir="$PWD/$target_dir"
  CARGO_TARGET_DIR="$target_dir" wasm-pack build "$build_dir/studio" \
    --release --target web --no-typescript --no-pack --out-dir "$PWD/web/pkg"
  rm -rf -- "$build_dir"
  trap - EXIT
else
  wasm-pack build --release --target web --no-typescript --no-pack --out-dir web/pkg
fi

if $build_only; then
  exit 0
fi

echo "run.sh: serving at http://127.0.0.1:$PORT (Ctrl-C to stop)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory web
