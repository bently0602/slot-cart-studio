# Restore horizontal card flow

Status: complete

Keep the native HorizonJS DataView library and restore cards arranged horizontally,
wrapping into additional rows as needed.

Horizon creates its DataView element independently of the component ID. The old
`#grid` style selector did not match that generated element. Give the component
an explicit root and a layout class, then verify multiple games at desktop and
narrow widths and after switching platforms.

Verification:

- All 11 browser workflows pass. Seven games arrange across rows at 1280 px,
  wrap into two columns at 400 px, and leave no empty gaps on platform switching.
- Desktop and narrow screenshots were inspected.
- Both desktop targets were rebuilt; Windows packaged integration passes.
- Refreshed both release ZIPs and verified their contents and executable modes.
- The running Windows executable was retained; a refreshed copy is also available
  under `dist/windows-x64-updated`. Close the old app before replacing it.
