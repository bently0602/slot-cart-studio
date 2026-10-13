# Centered modal item editors

Status: complete

Open cartridge and album editors as centered Horizon modal windows when an item
is clicked. Use the framework's mask to block the underlying interface, and keep
the window centered and within the viewport after resizing. Mark editor dialogs
for accessibility and keep the background regions out of keyboard interaction.
Verify opening, resizing, closing, and existing editing workflows, then refresh
both desktop downloads.

Verification:

- All 14 browser workflows pass. Both clicked-item editors are centered and
  masked; resizing preserves centering and closing restores the background.
- The modal check covers a blocked background click, keyboard exclusion,
  the Close button, and Escape after the framework's focus transition settles.
- Existing card, album, tab, import, history, and save workflows pass using
  controls inside the modal or closing it before switching platforms.
- Both desktop targets and ZIPs were refreshed and verified; Windows packaged
  integration passes. The running executable was preserved.
