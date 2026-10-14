#!/usr/bin/env python3
"""Download game databases, covers, logos and existing labels for local Studio use.

Requires Git and Pillow. Reuses downloads; --offline rebuilds indexes from caches.
    python3 tools/cache-art.py --out out/near-art
    cart-studio --art-dir out/near-art
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.parse
import zlib
from pathlib import Path
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('near', Path(__file__).with_name('harvest-near.py'))
near = module_from_spec(spec)
spec.loader.exec_module(near)

NAMES = {
    'GBA': 'Nintendo - Game Boy Advance', 'GB': 'Nintendo - Game Boy',
    'GBC': 'Nintendo - Game Boy Color', 'SNES': 'Nintendo - Super Nintendo Entertainment System',
    'PSX': 'Sony - PlayStation',
}
FOLDERS = {'Named_Boxarts': 'boxart', 'Named_Logos': 'wheel'}


def folders_for(platform):
    # Disc artwork uses the full box cover; PSX clear logos aren't used by Studio.
    return {'Named_Boxarts': 'boxart'} if platform == 'PSX' else FOLDERS


def discard_broken_icc(body):
    """Drop invalid optional ICC profiles; retain every image-data chunk verbatim."""
    chunks = [body[:8]]
    offset = 8
    while offset < len(body):
        size = int.from_bytes(body[offset:offset + 4], 'big')
        end = offset + size + 12
        if end > len(body) or end - offset < 12:
            raise ValueError('Truncated PNG chunk')
        chunk = body[offset:end]
        broken_icc = (chunk[4:8] == b'iCCP' and
                      zlib.crc32(chunk[4:-4]) != int.from_bytes(chunk[-4:], 'big'))
        if not broken_icc:
            chunks.append(chunk)
        offset = end
    return b''.join(chunks)


def png_bytes(path, repository, seen=None):
    """Resolve Git's small symlink stubs, while keeping targets inside the repo."""
    from PIL import Image, UnidentifiedImageError
    repository = Path(os.path.abspath(repository))
    path = Path(os.path.abspath(path))
    if path.is_symlink():
        path = path.resolve()
    seen = set() if seen is None else seen
    if not path.is_relative_to(repository) or path in seen:
        raise ValueError(f'Invalid or circular image link: {path}')
    seen.add(path)
    body = path.read_bytes()
    if not body.startswith(b'\x89PNG\r\n\x1a\n') and len(body) <= 512:
        target = body.decode('utf-8').strip()
        if target.endswith('.png') and '\n' not in target:
            return png_bytes(path.parent / target, repository, seen)
    try:
        image = Image.open(io.BytesIO(body))
    except UnidentifiedImageError:
        if not body.startswith(b'\x89PNG\r\n\x1a\n'):
            raise
        # Some upstream covers contain an ICC profile with a bad checksum.
        # Pillow still verifies all essential PNG chunks after it is removed.
        body = discard_broken_icc(body)
        image = Image.open(io.BytesIO(body))
    with image:
        if image.format != 'PNG':
            # A few upstream .png files actually contain JPEG data. Preserve
            # their cover pixels while encoding the PNG format Studio needs.
            image.load()
            output = io.BytesIO()
            image.convert('RGBA').save(output, format='PNG')
            return output.getvalue()
        image.verify()
    return body


def store_image(root, platform, media, body):
    digest = hashlib.sha256(body).hexdigest()
    relative = f'{platform}/{media}/{digest}.png'
    path = root / relative
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.tmp', delete=False) as temporary:
            temporary.write(body)
        Path(temporary.name).replace(path)
    return relative


def checkout(root, platform, offline):
    repository = NAMES[platform].replace(' ', '_')
    path = root / 'source/repos' / repository
    url = f'https://github.com/libretro-thumbnails/{repository}.git'
    if not (path / '.git').exists():
        if offline:
            raise ValueError(f'No cached repository for {platform}')
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', '-c', 'core.symlinks=false', '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true',
                        'clone', '--depth=1', '--filter=blob:none', '--sparse', url, str(path)], check=True)
    elif not offline:
        deadline = time.monotonic() + 300
        while (path / '.git/index.lock').exists():
            if time.monotonic() >= deadline:
                raise ValueError(f'Git checkout is still busy for {platform}; retry when it finishes')
            time.sleep(1)
        subprocess.run(['git', '-C', str(path), 'pull', '--ff-only'], check=True)
    subprocess.run(['git', '-C', str(path), 'config', 'core.longpaths', 'true'], check=True)
    if not offline:
        subprocess.run(['git', '-C', str(path), 'sparse-checkout', 'set', *folders_for(platform)], check=True)
    commit = subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
    return path, url.removesuffix('.git'), commit


def cache_platform(root, platform, offline):
    repository, url, commit = checkout(root, platform, offline)
    dat_url = ('https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/' +
               ('redump/' if platform == 'PSX' else 'no-intro/') + urllib.parse.quote(NAMES[platform]) + '.dat')
    dat_path = root / 'dat' / (platform + '.dat')
    if not offline:
        body = near.fetch(dat_url)
        if b'game (' not in body:
            raise ValueError(f'Invalid database for {platform}')
        dat_path.parent.mkdir(exist_ok=True)
        temporary = dat_path.with_suffix('.tmp')
        temporary.write_bytes(body)
        temporary.replace(dat_path)
    elif not dat_path.exists():
        raise ValueError(f'No cached database for {platform}')
    thumbnails = {}
    errors = {}
    for folder, media in folders_for(platform).items():
        images = {}
        for path in sorted((repository / folder).glob('*.png')):
            try:
                images[path.stem] = store_image(root, platform, media, png_bytes(path, repository))
            except Exception as error:
                errors[f'{folder}/{path.name}'] = str(error)
        thumbnails[folder] = images
    result = {'database': f'dat/{platform}.dat', 'thumbnails': thumbnails,
              'source': url, 'commit': commit, 'errors': errors}
    near.write_json(root / 'source' / f'library-{platform}.json', result)
    return platform, result


def localize_index(root, index, jobs, offline):
    """Keep cartridge artwork and measured colors, with every image stored locally."""
    from PIL import Image
    urls = {}
    localized = {crc: dict(entry) for crc, entry in index.items()}
    for crc, entry in localized.items():
        for media in ('wheel', 'support-texture', 'support-scan'):
            path = entry.get(media)
            if not path:
                continue
            url = urllib.parse.urlparse(path)
            if not url.scheme:
                candidate = (root / path).resolve()
                if not candidate.is_relative_to(root.resolve()) or not candidate.is_file():
                    raise ValueError(f'Missing local artwork: {path}')
                continue
            platform = url.path.strip('/').split('/')[0]
            if url.scheme != 'https' or url.netloc != 'art.slot-cfw.fyi' or platform not in NAMES:
                raise ValueError(f'Unsupported artwork source: {path}')
            urls.setdefault(path, []).append((crc, platform, media))
    cache_path = root / 'source/hosted-files.json'
    cache = json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
    errors = {}

    def download(url):
        cached = cache.get(url)
        if cached and (root / cached).is_file():
            body = (root / cached).read_bytes()
            if hashlib.sha256(body).hexdigest() == Path(cached).stem:
                return url, cached
        if offline:
            raise ValueError(f'No cached artwork for {url}')
        body = near.fetch(url)
        with Image.open(io.BytesIO(body)) as image:
            if image.format != 'PNG':
                raise ValueError(f'Invalid artwork: {url}')
            image.verify()
        _, platform, media = urls[url][0]
        return url, store_image(root, platform, media, body)

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        pending = {pool.submit(download, url): url for url in urls}
        for count, future in enumerate(concurrent.futures.as_completed(pending), 1):
            url = pending[future]
            try:
                url, relative = future.result()
                cache[url] = relative
                for crc, _, media in urls[url]:
                    localized[crc][media] = relative
            except Exception as error:
                errors[url] = str(error)
                # Offline mode must never hide an HTTP request behind a missing image.
                for crc, _, media in urls[url]:
                    localized[crc].pop(media, None)
            if count % 100 == 0 or count == len(urls):
                near.write_json(cache_path, cache)
                print(f'Cached checksum artwork: {count}/{len(urls)}', flush=True)
    return localized, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path('out/near-art'))
    parser.add_argument('--jobs', type=int, choices=range(1, 9), default=8)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    root = args.out
    (root / 'source').mkdir(parents=True, exist_ok=True)
    index_path = root / 'index.json'
    if index_path.exists():
        index = json.loads(index_path.read_text(encoding='utf-8'))
    else:
        if args.offline:
            parser.error('No cached index.json')
        index = near.rebase_index(json.loads(near.fetch(near.HOSTED + 'index.json')), near.HOSTED)
    if not args.offline:
        hosted = near.rebase_index(json.loads(near.fetch(near.HOSTED + 'index.json')), near.HOSTED)
        for crc, entry in hosted.items():
            index.setdefault(crc, {}).update(entry)
        # The authentic SNES crops remain preferred when the hosted collection updates.
        sources = root / 'sources.json'
        if sources.exists():
            for game in json.loads(sources.read_text(encoding='utf-8'))['games'].values():
                for crc in game['checksums']:
                    index.setdefault(crc, {})['support-texture'] = game['label']
    library = {'version': 1, 'offline': True, 'platforms': {}}
    report = {'platforms': {}, 'checksum_artwork_errors': {}}
    # Start localization while repository snapshots and databases are prepared.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        localization = pool.submit(localize_index, root, index, args.jobs, args.offline)
        pending = {pool.submit(cache_platform, root, p, args.offline): p for p in NAMES}
        for future in concurrent.futures.as_completed(pending):
            platform, data = future.result()
            library['platforms'][platform] = {k: data[k] for k in ('database', 'thumbnails')}
            report['platforms'][platform] = {k: data[k] for k in ('source', 'commit', 'errors')}
            report['platforms'][platform]['counts'] = {k: len(v) for k, v in data['thumbnails'].items()}
            print(f'{platform}: {report["platforms"][platform]["counts"]}', flush=True)
        index, report['checksum_artwork_errors'] = localization.result()
    near.write_json(index_path, index)
    near.write_json(root / 'library.json', library)
    near.write_json(root / 'library-report.json', report)
    (root / 'LIBRARY.txt').write_text(
        'Local Cart Studio game artwork library\n'
        'Covers and named logos: https://github.com/libretro-thumbnails/libretro-thumbnails\n'
        'Names/checksums: https://github.com/libretro/libretro-database (CC BY-SA 4.0)\n'
        'Checksum artwork: https://art.slot-cfw.fyi/ (ScreenScraper; CC BY-NC-SA 4.0)\n'
        'Original Near SNES labels retain their attribution in sources.json.\n'
        'library-report.json records repository revisions, counts and missing/invalid files.\n'
        'Launch: cart-studio --art-dir /path/to/near-art\n'
        'Game databases and artwork are local; music search still requires the internet.\n', encoding='utf-8')
    errors = len(report['checksum_artwork_errors']) + sum(len(p['errors']) for p in report['platforms'].values())
    print(f'Local library ready: {errors} unavailable/invalid images (see library-report.json)', flush=True)
    if errors:
        parser.exit(1)


if __name__ == '__main__':
    main()
