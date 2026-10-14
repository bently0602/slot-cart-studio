# Download missing artwork from the desktop executable

Status: complete

Follow-up: task 024 changes the default storage location to an artwork folder
beside the executable. The user-data locations below describe the initial implementation.

When no explicit or adjacent artwork collection is installed, serve databases and
artwork through a persistent per-user cache. Download files as games need them,
then reuse them on later runs. The executable must work without Python, Git,
GoTask or an artwork ZIP. Keep explicit/prepared collections supported.

Use platform-appropriate user data storage, expose a cache-directory override,
and handle network failures without replacing existing labels or saving partial
downloads. Browser artwork requests must stay on localhost. Verify first downloads,
cache reuse across restarts, offline use, aliases, concurrent requests and path guards.
Update packaged instructions and build both supported native targets.

Added a native on-demand artwork cache. The default executable serves its artwork
manifest on localhost, downloads matching databases only for platforms on the card,
and caches requested covers, logos and checksum artwork. Existing --art-dir and
adjacent prepared collections remain supported. --cache-dir overrides user storage;
--no-art-download restricts the automatic cache to previously downloaded files.

Storage defaults: Windows LOCALAPPDATA/CartStudio/artwork, macOS
~/Library/Application Support/CartStudio/artwork, Linux XDG_DATA_HOME/cart-studio/artwork
or ~/.local/share/cart-studio/artwork. Runtime requires no Python, Git or GoTask.
Downloads are bounded, validated and atomically saved; per-file locks deduplicate
concurrent requests, with four upstream downloads at a time. Only true image 404s
are remembered for a day; metadata/network failures remain retryable. Thumbnail
aliases are resolved locally and JPEG/GIF covers are converted to PNG. Broken
optional ICC profiles are removed while damaged image data is rejected.

Authentic SNES labels remain available: embedded reviewed crop metadata and 800
retail checksums cover all 716 Near scans. Only the requested original scan is
downloaded, checked against SHA-1 and dimensions, then cropped, rotated and padded
to 960x584. Only the prepared label is retained, alongside attribution and catalog
metadata. tools/near-checksums.py regenerates the embedded CRC map from a local DAT.

Validation: 16 native desktop tests and Clippy; four artwork JS tests; the full
browser suite (30 passed, three opt-in skips); and three packaged Windows tests.
The latter exercise five-platform matching/label export with external requests
blocked and persistent cache reuse after restarting the executable. A fresh live
Windows trial downloaded actual databases/covers for all five platforms and the
Chrono Trigger scan, then reopened/exported the authentic label after restarting
with artwork downloads disabled. Native cropping differs from the reviewed Pillow
output by less than 0.12 RGB levels per channel on average.

Rebuilt Windows x64 and macOS arm64 binaries under out/desktop-auto-art. Updated
out/packages/cart-studio-windows-x64.zip and cart-studio-macos-arm64.zip include
the standalone executable and platform instructions; both passed ZIP integrity
checks. macOS execution was not tested on this Windows host.
