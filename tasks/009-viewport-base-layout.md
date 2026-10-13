# Viewport base layout

Status: complete

Use Horizon's Viewport and component layouts to own the app's base sizing and
scrolling, keeping the horizontally wrapping DataView.

The existing root Viewport used border regions but its center contents followed
document flow. Make the Viewport explicit and identifiable; use a fixed header,
center workspace, and status region. Within the workspace, use a native toolbar,
notice region, and separately scrolling library with anchored DataView width.
Keep the header, platform controls, and status visible while the library scrolls.
Verify resizing, notices, and existing editing workflows; refresh desktop packages.

Verification:

- All 12 browser workflows pass, including fixed controls during library scrolling,
  notice-driven region resizing, toolbar height changes, and narrow viewports.
- Horizontal card flow remains covered at desktop and mobile sizes.
- Both desktop targets and ZIPs were refreshed. Windows packaged integration
  passes; archive contents and macOS executable permissions were verified.
- The running original Windows executable was preserved; the refreshed executable
  is in `dist/windows-x64-updated` and the updated Windows ZIP.
