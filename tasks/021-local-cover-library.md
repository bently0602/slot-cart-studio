# Predownload and serve artwork for all supported game platforms

Status: complete

Download the available GBA, GB, GBC, SNES, and PSX cover collections before Studio
is used. Cache the matching databases and existing logos/labels as well, so game
artwork can be loaded locally without calling external lookup/image services.
Preserve the prepared authentic SNES labels. Provide a resumable update tool,
local desktop serving, coverage reporting, and a portable artwork package.
Verify artwork selection and saving while external game-artwork requests are blocked.

Implemented tools/cache-art.py with resumable Git snapshots, cached No-Intro/Redump
databases, alias resolution, PNG validation and local checksum artwork. Mislabeled
JPEGs are converted to PNG; invalid optional ICC profiles are removed while image
data checksums remain enforced. Existing authentic Near SNES labels are preserved.

The prepared library at out/near-art contains 22,122 covers (GBA 5,961; GB 1,647;
GBC 1,524; SNES 3,689; PSX 9,301), 8,222 named logos and 716 Near SNES labels.
All index image references are local and library-report.json records zero errors.

Studio reads matching databases and artwork exclusively from the local library
when library.json is present, with placeholders for missing artwork. The desktop
serves the manifest, five databases and platform artwork; a cart-studio-art folder
beside the executable is detected automatically. Music search remains online.
tools/pack-art.py exports only referenced files and attribution, excluding raw
scans and Git snapshots. Data preparation is exposed through the task data:* commands.

Validation: five cache importer tests, three portable package tests, three local
artwork JS tests, eight Rust desktop tests, and two packaged Windows browser tests
passed. The browser suite previously passed 30 tests with three opt-in skips,
including offline SNES label selection/save with external artwork requests blocked.
The packaged Windows server also served actual databases and covers for all five
platforms in 11 requests restricted to localhost. Both native targets were built
under out/desktop-local-art and packaged under out/packages; macOS execution was
not tested on this Windows host.

out/packages/cart-studio-art.zip contains 31,033 referenced files (9.51 GB) and
passed the complete ZIP integrity check. No original scans or Git caches are included.
