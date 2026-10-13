# Load SNES artwork without the hosted collection

Status: complete

SNES games match correctly but the hosted artwork index has no SNES images. Prefer
the hosted checksum-matched logos, then fetch named SNES logos from libretro when
the preferred logo is missing, unreadable, or unavailable. Retain alias handling,
concurrency limits, progress masking, existing labels, imports, and saving.

Verify empty/failed artwork services, regional logo aliases, preferred hosted
artwork, stale card replacement, and direct/ZIP output. Check live provider images
and refresh both desktop packages. Cartridge scans remain a separate hosted asset.

Verification:

- All 24 automated browser cases and 69 JavaScript unit cases pass. Coverage
  includes empty indexes, regional aliases, missing/corrupt/failed hosted logos,
  hosted-image priority, missing fallback images, direct writes, ZIP output,
  loading masks, and stale card replacement. Game-menu selection uses the native
  trigger and waits for initial modal focus rather than racing a delayed query.
- The opt-in live browser test passes with Super Mario World, following its
  European logo alias and rendering the downloaded image. The live check is
  skipped in normal CI; use STUDIO_LIVE_SNES=1 to run it.
- Live Super Mario World, Super Metroid, and Donkey Kong Country logo aliases
  resolve to PNGs. The hosted index still contains no SNES entries.
- Windows and macOS targets and ZIPs were rebuilt and verified. Windows packaged
  integration passes, including equality of served source and embedded assets.
