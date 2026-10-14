# Add Download Assets to the top toolbar

Status: complete

Add a native HorizonJS Download Assets toolbar button, connected to the persistent
artwork downloader. Show masked progress while downloading and report completion
or failures, preserving labels and edits. Document its scope and rebuild the
desktop packages after browser verification.

The user selected the entire five-platform library. The Download Assets button is
available before choosing a card in the automatic desktop cache. A native background
job prepares all five databases, lists libretro cover/logo folders, and downloads
hosted cartridge artwork and every reviewed Near SNES label through the validated
cache. Catalogs are cached for a day; per-folder GitHub trees avoid response limits.
Successful files are reused when resuming. Four workers run at a time; cancellation
stops new work and retains completed files. Progress distinguishes available,
missing and failed images, and failures remain retryable.

Added start/status/cancel localhost endpoints with method and same-origin checks.
The masked Horizon MessageBox includes Cancel download and stays masked until the
server stops. Browser reloads reconnect to active jobs. Card labels, selections and
edits remain unchanged. Prepared collections and --no-art-download disable the button.

Validation: 20 native tests and Clippy passed; four artwork JS tests, the full browser
suite (32 passed, three opt-in skips), and three packaged Windows browser tests passed.
A native Windows check planned 45,114 real assets from existing repository catalogs,
downloaded four files, then confirmed cancellation and retained cache data. Verified
the live GitHub root tree contract and visually checked the toolbar/progress dialog.
Updated platform instructions and rebuilt both ZIPs under out/packages, with integrity
checks. macOS was cross-built; execution was not tested on this Windows host.
