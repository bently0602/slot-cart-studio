# Trial original SNES labels from Near's archive

Status: complete

Download a small, explicitly selected sample of Near's original cartridge-label
scans. Inspect and prepare the real label area, map USA No-Intro CRCs to the scans,
and serve a local artwork index usable by Studio. Preserve the hosted collection
for other games and retain original card labels. Verify real-label selection,
rendering, and save/reopen behavior with the actual downloaded sample.

Keep the downloaded collection in ignored local output; do not publish or bundle
the scans into public releases. Record source attribution and the absence of an
explicit redistribution license in the archive metadata.

Implemented `tools/harvest-near.py` with three individually reviewed, hash-pinned
crops in `tools/near-labels.json`: Chrono Trigger, Donkey Kong Country, and Super
Metroid. Downloads are cached and verified before use. Original front-label pixels
are rotated and padded to 960×584 without stretching. Exact No-Intro title/region
matching includes USA retail revisions and shared Japan/USA Super Metroid; it
excludes prototype/beta and digital rereleases. The merged index preserves other
platforms through absolute URLs to the existing artwork host.

Prepared the real dataset in ignored `out/near-art`, with original scans and source
URL/hash/crop/checksum attribution in `sources.json`. Five retail CRCs map to the
three labels. No scans were placed in bundled web assets or release packages.
README documents regeneration, local serving, and selecting Real Label when an
existing card label is present.

Validation: all five importer tests passed; the actual downloaded Chrono Trigger
image passed browser selection/render/save/reopen, alongside the existing SNES
import/export workflow (two browser tests passed). Visual inspection confirmed
all three prepared crops and the editor preview. HTTP checks confirmed that all
five mapped CRCs serve their exact prepared PNGs with CORS, and hosted GBA artwork
retains its original URL. Preview: `out/browser/near-chrono-editor.png`.

The local art server is running on 127.0.0.1:8766 (PID recorded in
`out/near-art-server.pid`). The current desktop server on port 8765 supports the
existing `art` query override. Trial URL:
`http://127.0.0.1:8765/?art=http://127.0.0.1:8766/`.
