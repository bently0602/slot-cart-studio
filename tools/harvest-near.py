#!/usr/bin/env python3
"""Prepare original USA SNES labels from Near's cartridge scan archive.

Requires Pillow. Only individually inspected crops in near-labels.json are
accepted. Original scans stay in source/; no ROMs are downloaded. Output is
local artwork, not a collection to bundle into public desktop releases.

    python3 tools/harvest-near.py --all --out out/near-art
    python3 tools/serve-art.py out/near-art 8766
"""
import argparse
import concurrent.futures
import hashlib
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ITEM = 'near-snes-scans-png'
ARCHIVE = f'https://archive.org/details/{ITEM}'
DAT = ('https://raw.githubusercontent.com/libretro/libretro-database/master/'
       'metadat/no-intro/Nintendo%20-%20Super%20Nintendo%20Entertainment%20System.dat')
HOSTED = 'https://art.slot-cfw.fyi/'
CATALOG = Path(__file__).with_name('near-labels.json')
ALIASES = Path(__file__).with_name('near-title-aliases.json')


def fetch(url):
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'CartStudioArt/1.0'})
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.read()
        except (OSError, urllib.error.URLError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt * 2)


def retail_entries(dat):
    """Exact retail title and USA membership, including shared-region dumps."""
    titles = {}
    for body in re.findall(r'game\s*\((.*?)\n\)', dat, re.S):
        name = re.search(r'\bname\s+"([^"]+)"', body)
        crc = re.search(r'\bcrc\s+([0-9a-fA-F]{8})\b', body)
        if not name or not crc:
            continue
        name = name.group(1)
        parts = re.fullmatch(r'(.+?) \(([^)]+)\)(.*)', name)
        if not parts or 'USA' not in parts[2].split(', '):
            continue
        if re.search(r'Beta|Proto|Virtual Console|Classic Mini|Switch Online|Auto Demo|Aftermarket|Evercade|Retro-Bit', parts[3]):
            continue
        titles.setdefault(parts[1], {})[crc.group(1).upper()] = name
    return titles


def normalized_title(title):
    return re.sub('[^a-z0-9]', '', unicodedata.normalize('NFKD', title).lower())


def match_title(titles, archive_title, aliases):
    """Explicit aliases or unique punctuation-only equality; never fuzzy match."""
    if archive_title in aliases:
        title = aliases[archive_title]
        if title not in titles:
            raise ValueError(f'No USA retail database title for alias {archive_title!r}: {title!r}')
        return title
    candidates = [title for title in titles if normalized_title(title) == normalized_title(archive_title)]
    if len(candidates) != 1:
        raise ValueError(f'Expected one USA retail title for {archive_title!r}; found {candidates}')
    return candidates[0]


def usa_matches(dat, title):
    found = retail_entries(dat).get(title, {})
    if not found:
        raise ValueError(f'No USA retail No-Intro checksums for {title!r}')
    return found


def rebase_index(index, base):
    """Keep other platforms using their original host when serving locally."""
    return {crc: {key: urllib.parse.urljoin(base, value)
                  if key in ('wheel', 'support-texture', 'support-scan') and isinstance(value, str)
                  else value for key, value in entry.items()}
            for crc, entry in index.items()}


def verified_scan(path, url, sha1, offline=False):
    if path.exists() and hashlib.sha1(path.read_bytes()).hexdigest() == sha1:
        return
    if offline:
        raise ValueError(f'Missing or corrupt cached scan: {path}')
    data = fetch(url)
    if hashlib.sha1(data).hexdigest() != sha1:
        raise ValueError(f'Scan checksum changed: {url}; review the crop before importing')
    temporary = path.with_suffix('.download')
    temporary.write_bytes(data)
    temporary.replace(path)


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def prepare_label(source, destination, spec):
    from PIL import Image, ImageOps
    with Image.open(source) as scan:
        if list(scan.size) != spec['size']:
            raise ValueError(f'Unexpected scan dimensions: {source}')
        left, top, right, bottom = spec['crop']
        if not (0 <= left < right <= scan.width and 0 <= top < bottom <= scan.height):
            raise ValueError(f'Invalid reviewed crop: {source}')
        label = scan.crop(spec['crop']).transpose(Image.Transpose.ROTATE_90).convert('RGB')
        # USA labels are wider than the device's generic SNES label well. Keep
        # the printed proportions with black padding, rather than stretching.
        label = ImageOps.pad(label, (960, 584), method=Image.Resampling.LANCZOS, color='black')
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix('.tmp')
        label.save(temporary, format='PNG', optimize=True)
        temporary.replace(destination)


def main():
    aliases = json.loads(ALIASES.read_text(encoding='utf-8'))
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--all', action='store_true', help='Build the full reviewed archive collection')
    selection.add_argument('--game', action='append',
                           help='Repeat for selected games; default: the original three-game sample')
    parser.add_argument('--jobs', type=int, choices=range(1, 9), default=4,
                        help='Concurrent downloads/preparation (1–8; default 4)')
    parser.add_argument('--offline', action='store_true', help='Use cached databases and scans only')
    parser.add_argument('--catalog', type=Path, default=CATALOG,
                        help='Reviewed crop catalog (default: tools/near-labels.json)')
    parser.add_argument('--out', type=Path, default=Path('out/near-art'))
    args = parser.parse_args()
    catalog = json.loads(args.catalog.read_text(encoding='utf-8'))
    unknown = set(args.game or []) - catalog.keys()
    if unknown:
        parser.error(f'No reviewed crop for {", ".join(sorted(unknown))}')
    source = args.out / 'source'
    source.mkdir(parents=True, exist_ok=True)
    if not args.offline:
        (source / 'snes.dat').write_bytes(fetch(DAT))
        (source / 'hosted-index.json').write_bytes(fetch(HOSTED + 'index.json'))
    dat = (source / 'snes.dat').read_text(encoding='utf-8')
    hosted = json.loads((source / 'hosted-index.json').read_text(encoding='utf-8'))
    titles = retail_entries(dat)
    index = rebase_index(hosted, HOSTED)
    index_path = args.out / 'index.json'
    if index_path.exists():
        index.update(json.loads(index_path.read_text(encoding='utf-8')))
    manifest_path = args.out / 'sources.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {
        'source': ARCHIVE, 'scanner': 'Near', 'dat': DAT,
        'usage': 'Local collection. Archive metadata does not specify a redistribution license.',
        'games': {},
    }
    games = list(dict.fromkeys(catalog if args.all else args.game or
                 ['Chrono Trigger', 'Donkey Kong Country', 'Super Metroid']))
    # Resolve every title before downloading. An ambiguous name cannot silently
    # become an incorrect label, and one spelling error won't waste a large run.
    matching = {game: titles[match_title(titles, game, aliases)] for game in games}
    failures = {}
    completed = 0

    def checkpoint():
        write_json(index_path, index)
        write_json(manifest_path, manifest)
        write_json(args.out / 'coverage.json', {
            'selected': len(games), 'completed': completed, 'failed': failures,
            'available_games': len(manifest['games']),
            'available_checksums': len({crc for entry in manifest['games'].values()
                                       for crc in entry['checksums']}),
        })

    def prepare(game):
        spec = catalog[game]
        matches = matching[game]
        url = f'https://archive.org/download/{ITEM}/' + urllib.parse.quote(game + '/cartridge.png')
        scan = source / (spec['slug'] + '.png')
        verified_scan(scan, url, spec['sha1'], args.offline)
        relative = f'SNES/support-texture/{spec["slug"]}.png'
        prepare_label(scan, args.out / relative, spec)
        return game, relative, {'url': url, **spec, 'rotation': 90,
                               'label': relative, 'checksums': matches}

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        pending = {pool.submit(prepare, game): game for game in games}
        for future in concurrent.futures.as_completed(pending):
            game = pending[future]
            try:
                game, relative, entry = future.result()
                for crc in entry['checksums']:
                    index.setdefault(crc, {})['support-texture'] = relative
                manifest['games'][game] = entry
                completed += 1
                print(f'{completed}/{len(games)} {game}: {len(entry["checksums"])} checksum(s)', flush=True)
            except Exception as error:
                failures[game] = str(error)
                print(f'FAILED {game}: {error}', flush=True)
            if (completed + len(failures)) % 16 == 0:
                checkpoint()
    checkpoint()
    (args.out / 'README.txt').write_text(
        "Original USA SNES cartridge scans by Near, from " + ARCHIVE + "\n"
        "Local collection; the archive metadata has no explicit redistribution license.\n"
        "Reviewed crops are rotated and padded to 960x584 without stretching.\n"
        "sources.json records source URLs, scan hashes, crops and matched retail CRCs.\n"
        "Other artwork entries remain on https://art.slot-cfw.fyi/.\n"
        "Serve with: python3 tools/serve-art.py out/near-art 8766\n"
        "Open Studio with: ?art=http://127.0.0.1:8766/\n"
        "Or launch the desktop: cart-studio --art-dir /path/to/near-art\n"
        "Choose Real Label in the item editor; Save writes the label to the card.\n",
        encoding='utf-8')
    print(f'Local artwork ready under {args.out}')
    if failures:
        parser.exit(1, f'{len(failures)} game(s) failed; see coverage.json. Rerun to resume.\n')


if __name__ == '__main__':
    main()
