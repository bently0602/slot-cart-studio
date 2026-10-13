#!/usr/bin/env python3
"""Export the prepared local SNES label collection, excluding large raw scans.

    python3 tools/pack-near.py out/near-art dist/near-snes-labels.zip
Extract the ZIP and launch cart-studio --art-dir /path/to/extracted/near-art.
"""
import json
import sys
import zipfile
from pathlib import Path


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else 'out/near-art').resolve()
    destination = Path(sys.argv[2] if len(sys.argv) > 2 else 'dist/near-snes-labels.zip')
    manifest = json.loads((root / 'sources.json').read_text(encoding='utf-8'))
    labels = {entry['label'] for entry in manifest['games'].values()}
    if not labels:
        sys.exit('No prepared labels; run tools/harvest-near.py first')
    names = sorted(labels | {'index.json', 'sources.json', 'coverage.json', 'README.txt'})
    files = []
    for name in names:
        source = (root / name).resolve()
        if not source.is_relative_to(root) or not source.is_file():
            sys.exit(f'Missing or invalid collection file: {name}')
        files.append((name, source))
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.tmp')
    # PNGs are already compressed; storing them keeps large exports quick.
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_STORED) as archive:
        for name, source in files:
            archive.write(source, 'near-art/' + name)
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None:
            sys.exit('ZIP integrity check failed')
    temporary.replace(destination)
    print(f'{len(labels)} labels exported to {destination} ({destination.stat().st_size / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
