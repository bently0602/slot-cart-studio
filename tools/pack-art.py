#!/usr/bin/env python3
"""Export the complete cached game artwork library, excluding raw scans/Git caches.

    python3 tools/pack-art.py out/near-art dist/cart-studio-art.zip
    cart-studio --art-dir /path/to/extracted/cart-studio-art
"""
import json
import os
import sys
import zipfile
from pathlib import Path


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else 'out/near-art').resolve()
    destination = Path(sys.argv[2] if len(sys.argv) > 2 else 'dist/cart-studio-art.zip')
    library = json.loads((root / 'library.json').read_text(encoding='utf-8'))
    index = json.loads((root / 'index.json').read_text(encoding='utf-8'))
    names = {'index.json', 'library.json', 'library-report.json', 'LIBRARY.txt'}
    for name in ('sources.json', 'coverage.json', 'README.txt'):
        if (root / name).is_file():
            names.add(name)
    for platform in library['platforms'].values():
        names.add(platform['database'])
        for images in platform['thumbnails'].values():
            names.update(images.values())
    for entry in index.values():
        names.update(entry[key] for key in ('wheel', 'support-texture', 'support-scan') if entry.get(key))
    files = []
    directories = {}
    for name in sorted(names):
        if '://' in name:
            sys.exit(f'Missing or nonlocal library file: {name}')
        candidate = root / name
        parent = candidate.parent
        if parent not in directories:
            resolved = parent.resolve()
            entries = {}
            if resolved.is_relative_to(root) and resolved.is_dir():
                with os.scandir(resolved) as listing:
                    entries = {entry.name: entry for entry in listing}
            directories[parent] = (resolved, entries)
        resolved, entries = directories[parent]
        entry = entries.get(candidate.name)
        path = resolved / candidate.name
        if entry is None or not entry.is_file() or (entry.is_symlink() and not path.resolve().is_relative_to(root)):
            sys.exit(f'Missing or nonlocal library file: {name}')
        files.append((name, path))
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.tmp')
    print(f'Packaging {len(files)} local library files...', flush=True)
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_STORED) as archive:
        for count, (name, path) in enumerate(files, 1):
            archive.write(path, 'cart-studio-art/' + name)
            if count % 5000 == 0:
                print(f'Packaged {count}/{len(files)} files', flush=True)
    print('Checking ZIP integrity...', flush=True)
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None:
            sys.exit('ZIP integrity check failed')
    temporary.replace(destination)
    print(f'{len(files)} local library files exported to {destination} ({destination.stat().st_size / 1e9:.2f} GB)')


if __name__ == '__main__':
    main()
