# Add a loading screen for Real Label

Status: complete

Show a prominent loading overlay and spinner over the main game preview while a
selected Real Label downloads. Remove it when the image is ready, fails, or the
user chooses another image. Keep the existing preview underneath and retain retry
and selection behavior. Verify the overlay lifecycle and rebuild the Windows app.

Implemented a translucent preview overlay with an animated spinner, loading text
and an accessible indeterminate progress indicator. Reduced-motion preferences
disable the animation. The overlay follows the selected Real Label's loading
state and clears on completion, failure, or selection changes.

Validation: four browser workflow checks and all three packaged Windows checks
passed. Visually verified the loading screen with actual Donkey Kong Country art.
Windows build: dist/windows-x64/cart-studio-loading.exe.
Screenshot: out/browser/loading-screen-real-label-loading.png.
