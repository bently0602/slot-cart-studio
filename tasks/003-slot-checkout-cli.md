# Select the slot checkout from the build CLI

Status: complete

Add `--slot-dir PATH` to `build-desktop.sh` and `run.sh` so an existing slot checkout
can be used without renaming it or manually creating a `slot-b` symlink.

## Implementation

- Resolve explicit paths relative to the caller's working directory and support spaces.
- Forward the selected checkout from the desktop build to the WASM build.
- Stage Rust sources in a temporary directory with the expected sibling layout so
  Cargo dependencies and Rust source imports all use the selected checkout.
- Preserve the default layout and output paths; clean up staging on success or failure.
- Document usage and validate invalid options and missing checkout paths.

## Verification

- Bash syntax checks and `git diff --check` pass.
- Seven Linux CLI integration tests pass, covering caller-relative paths with spaces,
  absolute paths, default behavior, invalid inputs, desktop forwarding/packaging,
  cleanup after failure, and preservation of an existing default checkout. Build
  commands are stubbed in these tests; they do not certify the desktop binaries.
- A real optimized WASM build from the staged source tree against the existing
  `../slot` checkout passes, including generation into an absolute output path with
  spaces. Both Cargo dependencies and renderer source imports resolve correctly.
- Full desktop packaging was not repeated: direct execution with `--slot-dir ../slot`
  passes checkout selection and stops because Linux Node.js is absent in this WSL
  environment. The user is managing Node.js installation themselves.
