# Studio-only app navigation

Status: complete

Remove the app's unrelated slot website navigation and keep the studio workflows,
including scanning/artwork lookup, editing, album covers, scraping tools, and exports.

## Implementation

- Remove Installing, Guide, Buttons, Questions, Credits, and AI navigation links.
- Point the header logo at the local Studio home and retain the active Studio link.
- Remove the unused hamburger menu and its JavaScript/CSS, keeping Studio visible
  on desktop and mobile.
- Keep all studio tools and artwork/provider attribution.

## Verification

- All seven Chromium browser workflows pass, covering card scanning, artwork
  lookup, editing, music covers, direct writes, and ZIP export.
- Inspected desktop and mobile screenshots: only Studio remains in the header,
  with no hidden or stale hamburger navigation.
- Updated the existing legacy UI verification to expect only local Studio links;
  Python/JavaScript syntax and Git whitespace checks pass.
- Rebuilt Windows x64 and macOS arm64 executables and refreshed their ZIP packages.
  The packaged Windows browser integration check passes. The macOS cross-build
  succeeds with the previously discussed SDK lookup warning; Mac runtime testing
  remains unavailable here.
- Checked that both refreshed ZIPs contain their current binaries, README files,
  and the macOS first-run helper with executable permissions.
