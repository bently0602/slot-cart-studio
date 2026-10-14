# Show SNES artwork without the cartridge shell

Status: complete

Remove the gray SNES cartridge surround from library cards, editor previews and
label choices. Show the selected artwork by itself and hide SNES shell controls.
Keep label selection, imports and the device's 960 × 584 exports working.

SNES now renders artwork directly at 240 × 146 in library cards, the editor and
label choices. Missing artwork uses a title placeholder. Shell controls are hidden
for SNES; the other platforms continue using their existing cartridge renderer.
Existing, imported, real and generated labels still export at 960 × 584.

Validation: 73 JavaScript tests, nine native renderer tests, 33 browser checks and
three packaged Windows checks passed. Two optional live-provider checks were
skipped. The browser run included actual Near artwork and save/reopen coverage.
Visually checked Donkey Kong Country in the rebuilt executable's library and
editor. Built against the existing local slot checkout to retain its renderer
changes for other platforms.

Windows build: dist/windows-x64/cart-studio-artwork.exe. It sits beside the running
executable and reuses the same artwork directory. Close the current app and launch
this build to use the new preview. Screenshots are in
out/browser/snes-donkey-kong-card.png and out/browser/snes-donkey-kong-editor.png.
