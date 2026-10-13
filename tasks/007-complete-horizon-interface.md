# Complete HorizonJS interface and Cart Studio branding

Status: complete

Replace the remaining custom interface with HorizonJS components throughout the
application, and remove the slot product branding.

- Use a Horizon viewport, toolbars, data view, editor windows, forms, combo boxes,
  colour menus, progress bar, fill dialog, and About window with the bundled theme.
- Preserve card scanning, artwork lookups, custom imports, history, exports, and
  local browser/server delivery.
- Keep framework assets and licenses available locally; render filenames and
  external provider text safely.
- Use Cart Studio in visible titles, messages, download packages, and executable
  filenames. Keep technical renderer dependency and storage compatibility names.
- Verify editing and music workflows, narrow viewports, and packaged delivery.

Verification:

- 69 JavaScript unit tests and 10 Chromium workflows pass, including directory
  picker fallback, About credits, cartridge imports, substring/pasted game
  searches, presets, colour menus, history shortcuts, and narrow editor windows.
- Five desktop server tests pass; formatting and Clippy pass.
- Seven build-script CLI tests pass. The complete WSL build produces the renamed
  executables; framework assets and licenses are bundled and verified locally.
- Windows packaged browser integration passes, including exact UI asset bytes.
- Both release workflows validate with actionlint. ZIP contents, executable
  permissions, and mocked new/existing release publishing branches pass checks.
- Windows x64 and macOS arm64 downloads were rebuilt. The macOS cross-build
  retains its nonfatal SDK lookup warning; execution on a Mac was not tested.
