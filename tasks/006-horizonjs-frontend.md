# HorizonJS frontend

Status: complete

Use HorizonJS/HorizonJS as the studio's frontend framework, preserving local-server
delivery, scanning, artwork lookup, cartridge editing, album cover selection, and
direct writes/ZIP exports.

## Implementation

- Pin and vendor the published HorizonJS 1.0.0 runtime with source and notices.
- Build and serve the framework locally in web and desktop packages.
- Use Horizon components for the workspace and editors, platform buttons, and
  scan progress while keeping the renderer and card/lookup/export logic.
- Preserve studio-only navigation, responsive behavior, keyboard controls, and
  safe text rendering for filenames and provider responses.
- Verify the framework migration with browser workflows and packaged desktop checks.

## Verification

- Built the frontend with the user's installed WSL/nvm Node runtime; verified 240
  pinned framework assets and 267 CSS image references. Git preserves upstream
  bytes with `-text` attributes, keeping hashes valid on Windows and Linux.
- All 69 JavaScript tests and eight Chromium workflows pass. The new browser
  workflow checks local framework loading, keyboard platform selection, editor
  visibility, and card replacement while a platform button is hovered.
- Desktop and mobile screenshots were inspected. The studio palette, local
  navigation, card shelf, and responsive editor remain intact.
- Five native desktop-server tests, formatting, and Clippy checks pass.
- Windows x64 and macOS arm64 binaries and ZIP packages were refreshed. The
  packaged Windows integration test passes, including exact served framework
  assets, CSS/images/license delivery, MIME types, and tagged album parsing.
- The macOS cross-build succeeds with the existing nonfatal SDK lookup warning;
  execution on a Mac is not verified here.
- Both release workflows validate with actionlint; desktop releases now run the
  frontend browser workflows before publishing. No release was published during
  this implementation.
