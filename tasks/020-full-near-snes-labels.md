# Build the full local Near SNES label collection

Status: complete

Expand the three-game trial to the archive's full USA retail cartridge collection.
Verify downloaded scans, match archive titles to No-Intro checksums conservatively,
prepare actual front-label crops, inspect contact sheets and fix exceptions. Make
the complete usable collection available through Studio's existing local artwork
server, retaining the other hosted artwork. Include resumable downloads, explicit
coverage/error reporting and source attribution. Keep original scans and prepared
assets in ignored local output as with the approved trial.

Completed all 716 primary cartridge scans from Near's archive. Downloads were
SHA-1 verified; the individually reviewed, hash-pinned crop catalog now covers
the full set. Reviewed 18 contact sheets and corrected the damaged Ren & Stimpy
Buckeroo$ scan's crop manually. Added 82 explicit archive/No-Intro title aliases,
with unique punctuation-only matching for the remaining names. USA retail and
shared-region ROM revisions yield 800 exact checksum mappings. Digital rereleases,
prototypes and demos are excluded. Original wear/stickers remain visible; the
Super Mario RPG source is only 150 DPI.

The importer supports --all, --game, --jobs (1–8), --offline and --catalog, reuses
verified downloads, retries transient failures, atomically replaces prepared
PNGs, and checkpoints JSON every 16 results. coverage.json reports 716 completed,
800 available checksums and zero failures. Hosted artwork for other platforms is
preserved. sources.json retains scan URLs, hashes, crops and CRC attribution.

Added desktop --art-dir PATH: validates index.json before starting, serves the
local index and contained platform PNGs, and supplies /art/ as the frontend's
default artwork base. Explicit art query overrides still work. Local serving
restricts paths to index/media and checks canonical containment. Added portable
export tools/pack-near.py, excluding the 12.7 GB raw scans.

Built/verified local artifacts: dist/cart-studio-windows-x64.zip,
dist/cart-studio-macos-arm64.zip and dist/near-snes-labels.zip (533.1 MB).
dist/start-with-snes-labels.cmd launches the updated Windows executable with the
already prepared collection at out/near-art. The original running Windows copy
was preserved. The new launcher's PID/log are under out/full-snes-desktop.*.

Validation: checked every prepared PNG's integrity and 960×584 dimensions, every
manifest/catalog crop/hash, all 800 index mappings against the current No-Intro
database, and absence of conflicting CRC assignments. Seven importer tests,
seven Rust desktop tests, 69 JS/Worker tests, two targeted SNES browser tests,
two packaged Windows desktop browser tests, and seven WSL shell script tests
passed. Browser checks used the actual Chrono Trigger scan for save/reopen and
the packaged local artwork endpoint. Both binary ZIPs and the artwork ZIP passed
integrity checks. macOS was cross-built successfully, with the existing nonfatal
SDK discovery warning; macOS execution was not tested here.
