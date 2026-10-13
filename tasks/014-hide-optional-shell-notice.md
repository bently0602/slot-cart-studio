# Hide optional legacy shell notice

Status: complete

Suppress the misleading cart_shell.ini firmware notice when the browser rejects
the optional legacy filename. Keep normal shell read errors visible and preserve
the existing protection against writing unreadable shell settings.

Verify a card with no shell files and a browser that rejects .ini lookups, then
refresh the desktop downloads.

Verification:

- Browser regression passes: rejected legacy lookups show no notice, scanning
  completes, and actual shell read failures still display an error.
- All 20 card-reader tests pass; Windows packaged integration passes.
- Windows and macOS binaries and ZIPs were rebuilt and the archives verified.
