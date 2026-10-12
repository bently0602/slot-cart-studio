# SNES labels and music album covers

Status: implementation verified; production rollout pending credentials

Implement the user-approved plan: SNES scanning, raw/headerless matching, slot-rendered
labels and harvesting; folder-defined MP3/FLAC albums with local/embedded artwork,
reviewed MusicBrainz suggestions, JPEG/PNG imports, history, direct writes and ZIP
exports; a paced, cached Cloudflare lookup Worker; builds, tests and documentation.

Preserve existing covers unless replacement is requested. No music playback, tag
editing or edition-specific selection. Preserve unrelated workspace changes.

Delivery requires a published slot dependency revision, a populated SNES art set,
and a deployed Worker before the website release. Record any unavailable external
credentials or physical-device checks here rather than treating them as verified.

## Implemented

- SNES card scanning, raw/headerless matching, slot-rendered labels, artwork lookup,
  custom imports/history/saving, and colour-only shell controls.
- Recursive Music albums with tag/folder metadata, local/embedded cover precedence,
  reviewed search suggestions, JPEG/PNG imports, undo/redo/revert, direct writes and
  card-relative ZIP exports. Decoded covers retain proportions and local format/name.
- Cloudflare Worker with an identifying User-Agent, escaped release-group searches,
  one paced singleton SQLite Durable Object, bounded queue, 24-hour cache, and CORS.
- Locked local parser bundle and dependency notices; local/CI/desktop build integration,
  documentation, and release gates for the lookup route and published SNES artwork.
- SNES ScreenScraper harvesting, copier-header fallback/aliases, quota/region preferences,
  resumable output, and a deterministic mocked end-to-end harvester test.

## Published dependency

`slot.ref` pins `ae0ac6d907f62e69d98e41973cb9bd68aa9bafa6`, published on
`codex/studio-snes-music-dependency` in `bently0602/slot`.
[Draft dependency PR](https://github.com/bently0602/slot/pull/2).
This snapshot contains the shared scanner/renderer dependencies; the neighboring
checkout's other app/controller/save-state/PSX changes remain in its working tree.

## Verification

- Studio: 62 Rust tests, 69 JavaScript tests, 17 Python tests, and seven Chromium
  workflow checks pass. Formatting and native/WASM Clippy checks pass.
- Upstream snapshot: store/UI tests, formatting, Clippy for both crates/all targets,
  and `cargo check --workspace` pass.
- Optimized WASM and Windows x64/macOS arm64 packages build. The Windows executable
  passes an additional browser check for embedded asset equality and tagged album parsing.
  Outputs are in `dist/`. macOS cross-linking warns that the host has no Xcode SDK;
  the build succeeds, but running the app on a Mac remains unverified.
- Worker deployment dry-run passes. Wrangler's local runtime returned real MusicBrainz
  candidates with CORS, then served a repeat query from durable cache.
- Synthetic tones and images cover both card readers, hidden/Unicode/nested/root paths,
  duplicate titles, corrupt/missing tags, artwork precedence, PNG/JPEG imports, history,
  ZIP destinations, failed-write cleanup, stale queries/cards/downloads, and outages.

## Outstanding rollout

As checked on 2026-10-11, the production music endpoint returns HTTP 404 and the
published artwork index contains zero SNES entries. Wrangler is unauthenticated;
Cloudflare and ScreenScraper credentials were not available in the checked local
environments or repository secrets. Harvest/upload SNES artwork and deploy/verify
the Worker using the setup in README/worker/README before publishing the studio.
Saved-label/cover smoke testing on a physical slot device also remains outstanding.
No production studio release was published.

## Desktop server follow-up

The user's follow-up moves desktop album lookup into the local Rust server. The desktop
now defaults to its own `/api/music/search`; the static website retains the Worker. The
native server sets an identifying User-Agent, serializes HTTPS requests with a 1100 ms
interval and a pause after completion, honors Retry-After, backs off after failures,
bounds the active/queued requests to eight, and caches successes for 24 hours in memory
(256 entries/8 MiB). Cloudflare deployment is no longer required for desktop music search.
The existing `musicApi` override still works. Tests cover query/candidate compatibility,
pacing, duplicate caching, queue bounds, cooldowns, malformed/oversized responses, and
desktop endpoint selection. Five desktop server tests, desktop formatting/Clippy, and
all seven browser workflows pass. Both desktop targets were rebuilt. The packaged Windows
browser test confirms the local API configuration and picker requests; a live native
MusicBrainz lookup returned eight candidates with HTTP 200 in about 2.1 seconds, followed
by a cached repeat in 5 ms. macOS was cross-built but has not been run on a Mac.
