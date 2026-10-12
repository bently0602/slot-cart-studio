# slot cart studio

Cart labels for a [slot](https://slot-cfw.fyi) SD card, previewed on the same cart face the
frontend draws. Runs in the browser at [studio.slot-cfw.fyi](https://studio.slot-cfw.fyi).

Supports Game Boy Advance, Game Boy, Game Boy Color, PlayStation, SNES cartridges, and music
album covers. Both use the same editor; music searches run in the desktop's local server
or through the website's lookup Worker.

## Card layout and artwork

Choose the root of the SD card. SNES ROMs belong directly in `Games/SNES`: `.sfc`, `.smc`, `.swc`,
and `.fig` are recognized. Labels are PNGs at `Labels/SNES/<original-stem>.png`, exported at
960 × 584 to fit slot's 240 × 146 label well. Matching checks the original CRC first and, for
512-byte copier headers, the headerless CRC second. Correct a match in the cartridge editor,
choose real artwork or a generated logo label, or import a custom image. SNES supports shell
colour; its renderer has no finish or outline variants. Generated colours come from box art.

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

Builds run on Linux or WSL. The studio compiles slot's own cart-drawing sources, so the slot fork
must be checked out beside this repository as `slot-b`, at the commit [slot.ref](slot.ref) names:

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
  `npm run build` creates `web/vendor/music-metadata.js` for local, CI, and desktop builds.
- For the desktop builds only: [zig](https://ziglang.org/download/) on your `PATH` and
  `cargo install --locked cargo-zigbuild`.

`wasm-pack` 0.15.0 is downloaded into `~/.cargo/bin` by `run.sh` if it is missing.

### Run it in a browser

```bash
./run.sh
```

Builds the WASM into `web/pkg` and serves the studio at <http://127.0.0.1:8765>.
`./run.sh --build-only` stops after the build, and `PORT=9000 ./run.sh` serves on another port.

### Build the desktop executables

```bash
./build-desktop.sh
```

Builds the WASM, then cross-compiles a single-file app for each platform with the page compiled
into it. `dist/` is emptied first and ends up as one folder per platform:

```
dist/
  windows-x64/   slot-cart-studio.exe, README.txt
  macos-arm64/   slot-cart-studio, first-run.sh, README.txt
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

- **Windows:** run `slot-cart-studio.exe`. SmartScreen may warn about an unknown publisher:
  choose **More info**, then **Run anyway**.
- **macOS (Apple Silicon):** the build is not signed with an Apple Developer ID, so macOS reports
  a downloaded copy as damaged. Open Terminal in the folder and run `sh first-run.sh` once. After
  that, `./slot-cart-studio` starts it.

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

## License

GPL-3.0-or-later, same as slot. See [LICENSE](LICENSE).

Game names and CRCs come from
[libretro-database](https://github.com/libretro/libretro-database) (CC BY-SA 4.0); logos come
from [ScreenScraper](https://www.screenscraper.fr/) (CC BY-NC-SA 4.0). 

Game Boy is a trademark of Nintendo. Not affiliated with Nintendo.
