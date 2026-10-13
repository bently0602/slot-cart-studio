# GitHub Actions desktop releases

Status: complete

Build Windows x64 and macOS arm64 desktop packages in GitHub Actions and publish
both as downloadable GitHub Release assets.

## Implementation

- Trigger on `v*` tag pushes or a manual run naming an existing release tag.
- Build the selected tag against its pinned slot revision using the working Zig
  0.13.0/cargo-zigbuild 0.23.4 combination and the existing desktop build script.
- Run desktop-server, JavaScript, and browser workflow tests before publishing.
- ZIP each platform folder, retaining its README and the macOS first-run helper.
- Save separate workflow artifacts and publish both ZIP files in a release job
  with `contents: write`; keep the build job read-only.
- Support uploading to an existing release on reruns and document how to release.
- Invoke the child build script through Bash so Linux CI handles checkouts whose
  shell scripts do not have executable Git mode bits.

## Verification

- actionlint 1.7.12 and Bash syntax checks pass for the new release workflow.
- Seven build CLI integration tests pass, including invoking a non-executable
  `run.sh` from the desktop build on Linux.
- Executed the workflow's packaging step against the existing real Windows and
  macOS builds. Both ZIP files contain the correct binary and README; the macOS
  archive includes its first-run helper and retains executable Unix modes.
- Exercised the publish step with a stubbed GitHub CLI: creating a release uploads
  both assets and verifies the tag; existing releases receive both uploads and
  are published; failed uploads and missing assets stop the publish flow.
- Git whitespace checks pass. No workflow was pushed or run on GitHub and no
  release/tag was created during implementation. Commit/push the changes before
  pushing a release tag or dispatching the workflow.
