# Recover Download Assets from temporary upstream failures

Status: complete

The full-library job stopped while preparing the PSX cover catalog with an upstream
HTTP 500. Retry temporary server failures with bounded backoff, request only the
direct entries used by each artwork folder, and include the request URL in errors.
Verify recovery and persistent failures with local HTTP fixtures, then rebuild the
Windows executable while retaining the existing artwork cache.

Implemented three total attempts for HTTP 500/502/503/504 with bounded backoff.
Per-folder GitHub tree requests omit recursive traversal because only direct image
entries are used. Errors include the upstream URL and folder/catalog context.
Successful downloads remain cached; persistent server errors remain retryable.

Validation: all 22 native tests and Clippy passed, including temporary PSX catalog
failures, retry limits, error context, and successful recovery. Both Download Assets
browser tests and all three packaged Windows checks passed. A live run fetched the
missing PSX catalog, planned 45,114 assets and downloaded 12 files without failures
before cancellation. Rebuilt Windows as dist/windows-x64/cart-studio-fixed.exe beside
the running executable so its existing artwork folder is reused. The current app
must be closed and the fixed executable launched to use the new download behavior.
