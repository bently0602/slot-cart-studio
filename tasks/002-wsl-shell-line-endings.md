# WSL shell script line endings

Status: complete

Fix `./build-desktop.sh` failing in WSL 2 with
`env: $'bash\r': No such file or directory` after a Windows checkout.

## Implementation

- Normalize `build-desktop.sh` and `run.sh` to LF line endings.
- Add a Git attribute requiring LF for shell scripts on every platform.

## Verification

- Git reports `w/lf` and `text eol=lf` for both scripts; `git diff --check` passes.
- `bash -n build-desktop.sh run.sh` passes in Ubuntu on WSL 2.
- Direct execution of `./build-desktop.sh` now reaches `run.sh` without the shebang
  error. The full build stops at the dependency check because Linux `node` is
  missing in this WSL environment. Install Node.js 22 or newer and npm inside WSL,
  as required by README.md, before rerunning the build.
