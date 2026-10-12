#!/usr/bin/env bash
# Build the studio's WASM into web/pkg and serve web/ on localhost, from WSL.
#
#   ./run.sh              build, then serve at http://127.0.0.1:8765
#   ./run.sh --build-only build and stop
#   PORT=9000 ./run.sh    serve somewhere else
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-8765}"
WASM_PACK_VERSION=0.15.0
SLOT=../slot-b

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

# The build compiles slot's own sources from the checkout beside this one.
if [ ! -d "$SLOT/crates/slot-ui" ]; then
  echo "run.sh: no slot checkout at $SLOT; the studio builds against the fork with PlayStation in it" >&2
  exit 1
fi
pin="$(cat slot.ref)"
head="$(git -C "$SLOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$head" != "$pin" ]; then
  echo "run.sh: warning: $SLOT is at ${head:0:7}, slot.ref pins ${pin:0:7}; faces may differ from the deployed studio" >&2
fi

npm ci
npm run build
wasm-pack build --release --target web --no-typescript --no-pack --out-dir web/pkg

[ "${1:-}" = "--build-only" ] && exit 0

echo "run.sh: serving at http://127.0.0.1:$PORT (Ctrl-C to stop)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory web
