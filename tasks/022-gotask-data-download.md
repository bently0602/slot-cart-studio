# Separate artwork downloading into GoTask commands

Status: complete

Add a GoTask Taskfile with task data:download, independently callable cover and
SNES download stages, offline rebuilding and packaging. Keep data downloading
independent from desktop compilation. Document output paths and configurable
Python/concurrency settings, and verify task ordering and quoted paths.

Extended the existing taskfile.yml, preserving all build, serve and test commands.
task data:download runs data:download:snes then data:download:covers sequentially
because both update index.json. data:rebuild reuses cached originals and snapshots;
data:pack exports the portable library independently. No desktop build downloads
data. ART_DIR, PYTHON, JOBS and ART_ARCHIVE can be overridden on the command line.
Download tasks check Python/Pillow, and the cover task checks Git. Documented
requirements, defaults, commands, overrides and local serving in README.md.

Validated with GoTask 3.54.0: task listing, sequential download/rebuild dry runs,
Windows paths with spaces, interpreter/output overrides and independent packaging.
The portable verifier lives under ignored out/tools; no global Task installation
was changed. task data:pack successfully exported 31,033 files (9.51 GB) to
out/packages/cart-studio-art.zip and passed its complete ZIP integrity check.
