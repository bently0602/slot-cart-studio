import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pack', Path(__file__).with_name('pack-art.py'))
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)


class PackArtTests(unittest.TestCase):
    def library(self, root, media='GB/boxart/cover.png'):
        root.mkdir()
        (root / 'GB/boxart').mkdir(parents=True)
        (root / 'GB/boxart/cover.png').write_bytes(b'cover')
        (root / 'dat').mkdir()
        (root / 'dat/GB.dat').write_text('database')
        (root / 'library.json').write_text(json.dumps({'platforms': {
            'GB': {'database': 'dat/GB.dat', 'thumbnails': {'Named_Boxarts': {'Game': media}}},
        }}))
        (root / 'index.json').write_text(json.dumps({'12345678': {'wheel': media}}))
        (root / 'library-report.json').write_text('{}')
        (root / 'LIBRARY.txt').write_text('Attribution')

    def run_pack(self, root, destination):
        with patch('sys.argv', ['pack-art.py', str(root), str(destination)]), contextlib.redirect_stdout(io.StringIO()):
            pack.main()

    def test_package_includes_referenced_data_and_attribution_without_raw_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            root, destination = Path(folder) / 'art with spaces', Path(folder) / 'art.zip'
            self.library(root)
            (root / 'source').mkdir()
            (root / 'source/raw.png').write_bytes(b'large original scan')
            self.run_pack(root, destination)
            with zipfile.ZipFile(destination) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(archive.read('cart-studio-art/GB/boxart/cover.png'), b'cover')
                self.assertEqual(archive.read('cart-studio-art/LIBRARY.txt'), b'Attribution')
                self.assertEqual(len(archive.namelist()), 6)
                self.assertFalse(any('/source/' in name for name in archive.namelist()))

    def test_nonlocal_and_missing_images_fail_before_creating_an_archive(self):
        for media in ['../outside.png', 'https://example.com/cover.png', 'GB/boxart/missing.png']:
            with self.subTest(media=media), tempfile.TemporaryDirectory() as folder:
                root, destination = Path(folder) / 'art', Path(folder) / 'art.zip'
                self.library(root, media)
                (root.parent / 'outside.png').write_bytes(b'outside')
                with self.assertRaises(SystemExit):
                    self.run_pack(root, destination)
                self.assertFalse(destination.exists())

    def test_file_symlinks_cannot_export_data_outside_the_library(self):
        with tempfile.TemporaryDirectory() as folder:
            root, destination = Path(folder) / 'art', Path(folder) / 'art.zip'
            self.library(root, 'GB/boxart/link.png')
            outside = root.parent / 'outside.png'
            outside.write_bytes(b'outside')
            try:
                (root / 'GB/boxart/link.png').symlink_to(outside)
            except OSError:
                self.skipTest('File symlinks are unavailable on this host')
            with self.assertRaises(SystemExit):
                self.run_pack(root, destination)
            self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
