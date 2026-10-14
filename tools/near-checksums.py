#!/usr/bin/env python3
"""Refresh the executable's reviewed SNES CRC map from a local No-Intro DAT.

    python3 tools/near-checksums.py out/near-art/dat/SNES.dat
"""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('near', Path(__file__).with_name('harvest-near.py'))
near = importlib.util.module_from_spec(spec)
spec.loader.exec_module(near)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dat', type=Path)
    parser.add_argument('--out', type=Path, default=Path(__file__).resolve().parent.parent / 'desktop/near-checksums.json')
    args = parser.parse_args()
    catalog = json.loads(near.CATALOG.read_text(encoding='utf-8'))
    aliases = json.loads(near.ALIASES.read_text(encoding='utf-8'))
    titles = near.retail_entries(args.dat.read_text(encoding='utf-8'))
    checksums = {}
    for game in catalog:
        for crc in titles[near.match_title(titles, game, aliases)]:
            if crc in checksums and checksums[crc] != game:
                parser.error(f'Conflicting scan assignment for {crc}')
            checksums[crc] = game
    near.write_json(args.out, dict(sorted(checksums.items())))
    print(f'{len(checksums)} reviewed SNES checksums written to {args.out}')


if __name__ == '__main__':
    main()
