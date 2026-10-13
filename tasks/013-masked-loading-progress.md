# Masked loading progress

Status: complete

Move progress into a native Horizon MessageBox that masks the interface and cannot
be dismissed while loading. Keep it open through directory enumeration, scanning,
matching, music metadata, and artwork downloads. Handle required style choices
without blocking the choice dialog, and release the mask after errors or completion.
Use the same progress dialog for saving; preserve editor state and restore interaction.

Verify delayed concurrent loading, masking, completion, card replacement, and existing
editing/export workflows. Refresh desktop downloads.

Verification:

- All 15 browser workflows and 69 unit tests pass. Delayed metadata/artwork,
  Escape, narrow-screen centering, empty replacement cards, and directory failures
  verify that the mask stays up and is released correctly. The empty DataView
  placeholder is no longer treated as an item.
- A delayed direct save also verifies that the editor is blocked while saving and
  becomes usable afterward.
- Both desktop targets and ZIPs were rebuilt and verified; Windows packaged
  integration passes. The running original executable was preserved.
