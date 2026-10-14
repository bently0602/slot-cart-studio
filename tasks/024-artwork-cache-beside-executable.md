# Store automatic artwork beside the executable

Status: complete

Default the automatic cache to an artwork subdirectory beside the running executable
on every platform. Resolve the executable directory independently of the working
directory. Preserve --cache-dir overrides and explicit/prepared artwork collections.
Update instructions and rebuild the Windows and macOS packages.

The default uses current_exe().parent()/artwork on every platform. CLI overrides
and prepared collection precedence remain available. Cache creation errors include
the directory and the --cache-dir option for choosing a writable location. Updated
CLI help, README.md and both packaged platform instructions; removed obsolete
user-data-location checks from the existing filename guard test.

Validation: all 16 native tests and Clippy passed. Rebuilt Windows x64 and macOS
arm64 packages under out/packages, with ZIP integrity checks. Launched the Windows
executable from a different working directory and verified its cache manifest was
created beside the executable and served by the localhost endpoint. macOS was
cross-built successfully; execution was not tested on this Windows host.
