# Native platform TabPanel

Status: complete

Replace the platform button strip with a Horizon TabPanel. Use a native page per
platform, preserve counts, and keep the shared library and cartridge canvases alive
when moving between pages. Support native tab scrolling and accessible keyboard
activation. Verify platform selection, card replacement, existing editing flows,
and refreshed desktop packages.

Verification:

- All 13 browser workflows pass, including six-platform counts/order, native tab
  activation, keyboard navigation, and scrolling the tab strip at 260 px.
- Cartridge edits and the original canvas nodes survive platform switching.
- Card replacement, horizontal wrapping, Viewport scrolling, and music workflows
  remain covered. Responsive screenshots were inspected.
- Both desktop targets and ZIPs were rebuilt and verified. Windows packaged
  browser integration passes; the running original executable was preserved.
