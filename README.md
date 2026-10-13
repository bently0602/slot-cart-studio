# Cart Studio

Cartridge labels and music covers for a local SD card, previewed with the device's renderer.
Runs as a local web server that opens Cart Studio in your browser.

Supports Game Boy Advance, Game Boy, Game Boy Color, PlayStation, SNES cartridges, and music
album covers. Both share the library and save controls; music searches run in the desktop's local server
or through the website's lookup Worker.

The complete interface uses [HorizonJS](https://github.com/HorizonJS/HorizonJS): viewport,
toolbars, platform TabPanel, library data view, forms, colour menus, editor windows, fill dialog, and progress.
Its pinned 1.0.0 runtime, theme, readable source, and licenses are bundled locally, including
in desktop executables. See [third_party/horizonjs](third_party/horizonjs/README.md).

The base layout is a Horizon Viewport with border regions for the header, platform
TabPanel, and status bar. The header contains the controls and any notice; the library
scrolls independently and anchors the DataView to the available width, so cards wrap
while the main controls stay visible.
Platform tabs show item counts, scroll when needed, and share the library view so
switching platforms preserves cartridge previews and edits. Arrow keys, Home, End,
Enter, and Space work in the tab strip.
Clicking a cartridge or album opens a centered modal editor with a background mask.
The dialog stays within the viewport on resize; close it before switching platforms.
Card loading and saving show a centered Horizon MessageBox with progress and a full
background mask. Loading waits for game matching, music metadata, and artwork;
any required label-style choice is shown in its own masked dialog before finishing.

## Card layout and artwork

Choose the root of the SD card. SNES ROMs belong directly in `Games/SNES`: `.sfc`, `.smc`, `.swc`,
and `.fig` are recognized. Labels are PNGs at `Labels/SNES/<original-stem>.png`, exported at
960 × 584 to fit slot's 240 × 146 label well. Matching checks the original CRC first and, for
512-byte copier headers, the headerless CRC second. Correct a match in the cartridge editor,
choose real artwork or a generated logo label, or import a custom image. SNES supports shell
colour; its renderer has no finish or outline variants. Generated colours come from box art.
The SNES tab appears automatically when compatible ROMs are found. Existing SNES labels
are loaded from the card; imported labels, logos, undo/redo, and saving work like the handhelds.
Automatic GBA, GB, GBC, and SNES logos prefer the checksum-matched artwork index, then fall back to
libretro's `Named_Logos` collection for the matched game, including regional aliases.
This works when the hosted collection is empty or its logo is missing/unreadable.
Real cartridge scans still require SNES entries in the artwork index; existing labels
and manual imports remain available when a provider has no artwork for a game.
Coverage depends on the provider's collection. As checked on 2026-10-12, the GBC
thumbnail repository has no `Named_Logos` folder, so missing hosted GBC logos still
require a manual import.

Music lives anywhere below `Games/Music`. Each folder with direct MP3 or FLAC files is an album;
tracks in `Games/Music` itself form a root album. Hidden files and folders are ignored. For example:

```text
Games/Music/Artist/Album/01.mp3
Games/Music/Artist/Album/cover.jpg
Games/Music/Another Artist/Album/01.flac
```

The two `Album` folders stay separate. Tags supply album title and album artist (then track
artist); missing tags fall back to folder names. Artwork priority follows slot: `cover.jpg`,
`cover.jpeg`, `cover.png`, then embedded artwork. The parser is bundled locally; audio files are
read for metadata and never uploaded or decoded for playback.

Open an album with missing artwork to see suggestions. Edit the artist/title search, then select
a cover or import a JPEG/PNG. Existing covers are retained until you request a replacement.
Selection changes the preview; **Write to card** or **Download ZIP** saves the change separately.
Undo, redo, and revert are available. Failed searches or missing covers still allow manual import.

New covers are `cover.jpg`. Replacements retain the original local cover's filename and format,
including its case; embedded artwork is never changed. Covers keep their proportions and are
limited to a 1200-pixel longest edge. Only the square preview crops. Input limits match slot:
20 MiB compressed artwork and 4096 pixels per edge. Chrome/Edge can write directly; a failed
write preserves the existing file and removes any newly created incomplete file. Other browsers
export `Games/Music/<album-path>/cover.*` alongside `Labels/` in the ZIP. Unzip at the card root
and merge both folders.

Album matching uses [MusicBrainz release groups](https://musicbrainz.org/doc/MusicBrainz_API).
Representative front covers come directly from [Cover Art Archive](https://musicbrainz.org/doc/Cover_Art_Archive/API).
No cover is selected automatically. Playback, tag editing, and edition-specific selection are
outside this version.

## Building

Builds run on Linux or WSL. The studio compiles slot's own cart-drawing sources, so you need
the slot fork at the commit [slot.ref](slot.ref) names. By default it is checked out beside
this repository as `slot-b`:

```
Repos/
  slot-b/             https://github.com/bently0602/slot
  slot-cart-studio/   this repository
```

You need:

- Rust through [rustup](https://rustup.rs); [rust-toolchain.toml](rust-toolchain.toml) picks the
  version and the `wasm32-unknown-unknown` target.
- Python 3, to serve the page locally.
- Node.js 22 or newer and npm. `npm ci` installs the locked parser and esbuild dependencies;
  `npm run build` verifies and copies HorizonJS to `web/vendor/horizonjs` and creates
  `web/vendor/music-metadata.js` for local, CI, and desktop builds. Use Node and npm from
  the same platform as `node_modules`; WSL and Windows need their own `npm ci` run.
- For the desktop builds only: [zig](https://ziglang.org/download/) on your `PATH` and
  `cargo install --locked cargo-zigbuild`.

`wasm-pack` 0.15.0 is downloaded into `~/.cargo/bin` by `run.sh` if it is missing.

### Run it in a browser

```bash
./run.sh
```

Builds the WASM into `web/pkg` and serves the studio at <http://127.0.0.1:8765>.
`./run.sh --build-only` stops after the build, and `PORT=9000 ./run.sh` serves on another port.
Use `./run.sh --slot-dir ../slot` to select a checkout with another name or location.

### Build the desktop executables

```bash
./build-desktop.sh
```

To select an existing slot checkout elsewhere:

```bash
./build-desktop.sh --slot-dir ../slot
```

`--slot-dir PATH` accepts an absolute path or a path relative to the directory you run
the command from. Quote paths containing spaces. Both scripts use the selected checkout
for the Rust dependencies and renderer sources through a temporary build tree, and write
the output into this studio's usual directories. They do not rename the checkout or edit
Cargo manifests. Direct Cargo commands and the CI workflow still use the default `../slot-b` layout.

Builds the WASM, then cross-compiles a single-file app for each platform with the page compiled
into it. `dist/` is emptied first and ends up as one folder per platform:

```
dist/
  windows-x64/   cart-studio.exe, README.txt
  macos-arm64/   cart-studio, first-run.sh, README.txt
```

### Tests

```bash
cargo test
npm ci && npm run build
npm test
python3 -m pip install Pillow numpy
python3 -m unittest discover -s tools -p 'test_*.py'
npx playwright install chromium
npm run test:browser
```

After building the desktop app, `npm run test:desktop` on Windows/macOS verifies the executable's
embedded WASM/parser assets and reads a synthetic tagged album in its browser. Set `STUDIO_DESKTOP`
to test a binary outside `dist/`, or `STUDIO_CHROME` to use another Chromium executable.
With the web assets built, `cargo test --manifest-path desktop/Cargo.toml` runs the local
server's deterministic MusicBrainz tests, including pacing, caching, queue limits and backoff.

## Deploying

### Desktop

Copy the platform's folder from `dist/` to the machine that will use it. Nothing needs
installing. The app starts a server on `127.0.0.1` and opens the studio in the default browser;
closing its window stops it. It needs the internet for game names, artwork, and album searches.
Use Chrome or Edge to write labels and covers straight to the card; other browsers download a
ZIP. The bundled parser and manual artwork imports work locally.

Album searches go directly from the local Rust server to MusicBrainz over HTTPS; the desktop
app needs no Cloudflare account or deployed Worker. All browser tabs share one server-side
request queue, with at least 1100 ms between upstream calls and a pause after each response.
The queue allows eight requests; overflow receives 429 with `Retry-After`. The server identifies
the app, honors MusicBrainz's `Retry-After` delays, and backs off after failures. Successful
queries cache for 24 hours in memory, bounded to 256 entries/8 MiB; closing the app clears it.
Cover images still download directly from Cover Art Archive in the browser.

- **Windows:** run `cart-studio.exe`. SmartScreen may warn about an unknown publisher:
  choose **More info**, then **Run anyway**.
- **macOS (Apple Silicon):** the build is not signed with an Apple Developer ID, so macOS reports
  a downloaded copy as damaged. Open Terminal in the folder and run `sh first-run.sh` once. After
  that, `./cart-studio` starts it.

### GitHub desktop releases

[release.yml](.github/workflows/release.yml) builds both desktop packages when a `v*` tag
is pushed. Commit and push the workflow and your changes first, then tag the commit to release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Choose an unused version tag. You can also run **Desktop release** from the repository's
Actions page and enter an existing `v`-prefixed tag. The workflow checks out that tag and
the slot revision it pins, builds with Zig 0.13.0 and cargo-zigbuild 0.23.4, and runs the
local-server, JavaScript, and browser workflow tests before publishing.

The GitHub Release contains two downloads, also saved as separate workflow artifacts:

- `cart-studio-windows-x64.zip`: Windows executable and README.
- `cart-studio-macos-arm64.zip`: Apple Silicon executable, `first-run.sh`, and README.

Extract the download into a folder and follow its README. Only the publish job has
`contents: write` permission; it uses GitHub's built-in token and requires no extra secrets.
Rerunning a tag uploads replacement assets to its existing release. This workflow is
independent of the GitHub Pages deployment and its Cloudflare configuration.

### Web

[pages.yml](.github/workflows/pages.yml) builds the WASM and publishes `web/` to GitHub Pages on
every push to `main`. It checks out `bently0602/slot` at the commit in `slot.ref`, so update that
file whenever the studio needs a newer slot. Its last step purges a Cloudflare cache and needs the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` secrets, and [CNAME](CNAME) names the domain the
site is served from; change or remove both for a different host.

### Music lookup Worker

Deploy the Worker in [wrangler.toml](wrangler.toml) before releasing the website.
See [worker/README.md](worker/README.md) for Cloudflare setup, local development, and verification.
The website defaults to `https://studio.slot-cfw.fyi/api/music/`; the desktop app defaults to its
own `/api/music/` endpoint. A `musicApi` query parameter overrides either base URL for development.

### SNES artwork

The existing ScreenScraper harvester includes SNES. Credentials remain environment variables
(`SS_DEVID`, `SS_DEVPASSWORD`, and optional `SS_SSID`/`SS_SSPASSWORD`); never commit them.

```bash
python3 tools/harvest.py --dat SNES --media wheel,support-texture --out ../slot-thumbnails
# Or harvest your card, including raw/headerless CRC aliases:
python3 tools/harvest.py --card /path/to/card --media wheel,support-texture --out ../slot-thumbnails
```

The script checks system IDs, preserves dump-region preferences, reads account quotas, and
resumes from the existing index. Publish the new `SNES/` files **with the merged index**, retaining
all other platforms, through the artwork host's existing upload process at `art.slot-cfw.fyi`.
SNES does not harvest cartridge-scan background measurements in this version. For local checks,
serve the output with `tools/serve-art.py` and set the studio's `art` query parameter.

Without ScreenScraper developer credentials, `tools/harvest-near.py` prepares the full
collection of **716 original USA SNES cartridge labels** from
[Near's scan archive](https://archive.org/details/near-snes-scans-png).
It requires Python 3 and Pillow. The crops are individually reviewed, checked against
the original scan hashes, and mapped to USA retail No-Intro checksums, including shared
region dumps and revisions. Explicit title aliases resolve archive/database naming
differences; ambiguous names are rejected. Other games retain the existing hosted artwork lookup.

```bash
python3 tools/harvest-near.py --all --out out/near-art
# Optional: limit to one game (default: the original three-game sample):
python3 tools/harvest-near.py --game "Chrono Trigger" --out out/near-art
# Rebuild using verified cached scans and databases:
python3 tools/harvest-near.py --all --offline --out out/near-art
```

The full first download is approximately 12.7 GB. Downloads are verified and reused on
reruns; up to four run concurrently (`--jobs 1` through `--jobs 8`). Every 16 results the
script checkpoints the index, attribution, and `coverage.json`. Failed scans are reported
without discarding completed work; rerun to resume. Crops retain genuine wear visible in
the source scans. Super Mario RPG's available source has a lower resolution.

The desktop launcher can serve the artwork itself, using the collection directory:

```powershell
.\cart-studio.exe --art-dir "Z:\slot-cart-studio\out\near-art"
```

On macOS, use `./cart-studio --art-dir /path/to/near-art`. The normal browser address
automatically uses this collection; an `art` query parameter still overrides it. For a
development server, run `python3 tools/serve-art.py out/near-art 8766` and open
`http://127.0.0.1:8765/?art=http://127.0.0.1:8766/` (adjust Studio's port if necessary).
Choose the card again, click a supported game, select **Real Label**, and save. Existing
card labels stay selected until you change them. USA label proportions are preserved
with black padding inside the device's 960×584 SNES label area.

The ignored `out/near-art` directory contains the original scans, prepared labels, merged
index, and `sources.json` attribution/crop/checksum records. This is a local collection; the
archive metadata specifies no redistribution license, so the scans are not bundled into
public desktop releases. Add more titles only after reviewing their individual crops in
`tools/near-labels.json`.

Export just the prepared collection (without the 12.7 GB originals) with:

```bash
python3 tools/pack-near.py out/near-art dist/near-snes-labels.zip
```

Extract it and pass the extracted `near-art` directory to `--art-dir`. The collection
contains 716 labels mapped to 800 retail ROM checksums. For this checkout, the local
`dist/start-with-snes-labels.cmd` launches the updated Windows binary with the existing set.

Verify the importer with `python3 -m unittest discover -s tools -p test_harvest_near.py`.
After harvesting, run the real-image browser check with
`STUDIO_NEAR_ART=out/near-art node --test --test-name-pattern="Near trial" tools/browser.test.mjs`.

## License

GPL-3.0-or-later, same as slot. See [LICENSE](LICENSE).

Game names and CRCs come from
[libretro-database](https://github.com/libretro/libretro-database) (CC BY-SA 4.0); logos come
from [ScreenScraper](https://www.screenscraper.fr/) (CC BY-NC-SA 4.0), with fallback logos
from [libretro-thumbnails](https://github.com/libretro-thumbnails).

Game Boy is a trademark of Nintendo. Not affiliated with Nintendo.
