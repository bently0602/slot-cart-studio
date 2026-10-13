# Verify SNES support against the device frontend

Status: complete (application support verified; hosted artwork rollout remains in task 001)

Audit existing SNES support against the neighboring slot checkout and verify ROM
scanning, raw/headerless CRC matching, cartridge previews, imports and editing,
direct writes, ZIP export, and reopening existing labels. Check the SNES scraper
and hosted artwork availability. Preserve the frontend's unrelated local changes.

The implementation already includes SNES. The hosted artwork index currently has
zero SNES entries; artwork harvesting/upload remains the rollout item in task 001.

Verification:

- Four existing browser workflows pass for SNES matching, wrapping, tab switching,
  editor imports/colours/history, and ZIP export. A new direct-write/reopen check
  verifies Labels/SNES/<original-stem>.png and 960 x 584 output.
- All 22 card-reader/checksum tests and eight harvester tests pass.
- A new native SNES parity check passes against Z:/slot, including label-well
  dimensions and pixel equality for automatic and custom shell colours.
- Full native library testing against that checkout has 47 passes and one unrelated
  existing PSX failure: its label well changed to 296 x 296 while Studio's export
  constant still targets the pinned 268 x 268 well. No PSX runtime changes were made.
- Documented automatic SNES tabs and the distinction between local editing/saving
  and availability of hosted artwork. Runtime support was already implemented;
  the current desktop packages already include it.
