# Polish loading and selection in the game image editor

Status: complete

The main preview disappears or loads oddly when choosing Real Label. Keep the
previous preview visible while replacement artwork loads, reserve preview space,
and clearly distinguish loading, selected, unavailable and retry states. Preserve
undo/redo and make sure late downloads cannot replace a newer choice.

Verify delayed downloads, failures/retry, switching choices, and desktop/mobile
layout in the browser. Rebuild the Windows app and inspect real artwork visually.

The main preview now retains its previous image during Real Label downloads and
stays visible above a separate scroll area for the choices. All choices share a
two-column grid with reserved preview space, selected styling, placeholders and
clickable thumbnails. Loading and failure messages explain what is displayed;
failed images have a retry action. Retrying the same selection refreshes its
loading state without creating an extra undo step. Opening another game resets
the preview so an old game's image cannot carry over.

Validation: all 73 JavaScript tests, 35 browser checks and three packaged Windows
checks passed. Two optional live-provider browser checks were skipped. New browser
coverage verifies retained previews, stable layout, failed downloads, retrying the
same selection, switching away during downloads, thumbnail selection, undo/redo
and mobile preview visibility. Visually checked actual Donkey Kong Country artwork
in the packaged app while loading and selected, at desktop and mobile sizes.

Windows build: dist/windows-x64/cart-studio-polished.exe. The running executable
was left open; this build uses the same adjacent artwork cache. Preview images:
out/browser/polished-real-label-loading.png,
out/browser/polished-real-label-desktop.png and
out/browser/polished-real-label-mobile.png.
