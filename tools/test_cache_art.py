import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cache', Path(__file__).with_name('cache-art.py'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheArtTests(unittest.TestCase):
    def test_broken_optional_icc_profiles_do_not_hide_corrupt_image_data(self):
        import io
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'cover.png'
            Image.new('RGB', (3, 2), 'red').save(path)
            original = path.read_bytes()
            # Add an optional profile with an invalid checksum after IHDR.
            profile = b'bad-profile'
            broken = len(profile).to_bytes(4, 'big') + b'iCCP' + profile + b'\x00' * 4
            path.write_bytes(original[:33] + broken + original[33:])
            repaired = cache.png_bytes(path, root)
            self.assertEqual(repaired, original)
            with Image.open(io.BytesIO(repaired)) as image:
                self.assertEqual(image.getpixel((0, 0)), (255, 0, 0))
            corrupt = bytearray(original)
            corrupt[original.index(b'IDAT') + 4] ^= 1
            path.write_bytes(bytes(corrupt))
            with self.assertRaises(Exception):
                cache.png_bytes(path, root)

    def test_image_aliases_are_resolved_and_invalid_targets_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            Image.new('RGB', (2, 1), 'blue').save(root / 'real.png')
            (root / 'alias.png').write_text('real.png')
            self.assertEqual(cache.png_bytes(root / 'alias.png', root), (root / 'real.png').read_bytes())
            (root / 'loop.png').write_text('loop.png')
            (root / 'escape.png').write_text('../outside.png')
            for name in ('loop.png', 'escape.png'):
                with self.assertRaises(ValueError):
                    cache.png_bytes(root / name, root)

    def test_corrupt_cached_images_are_repaired_and_duplicates_share_a_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'original.png'
            Image.new('RGB', (2, 1), 'blue').save(path)
            body = path.read_bytes()
            relative = cache.store_image(root, 'GB', 'boxart', body)
            (root / relative).write_bytes(b'corrupt')
            self.assertEqual(cache.store_image(root, 'GB', 'boxart', body), relative)
            self.assertEqual((root / relative).read_bytes(), body)

    def test_mislabeled_jpeg_covers_are_converted_to_readable_pngs(self):
        import io
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            Image.new('RGB', (3, 2), 'red').save(root / 'cover.png', format='JPEG')
            body = cache.png_bytes(root / 'cover.png', root)
            self.assertTrue(body.startswith(b'\x89PNG\r\n\x1a\n'))
            with Image.open(io.BytesIO(body)) as image:
                self.assertEqual(image.size, (3, 2))
                self.assertEqual(image.format, 'PNG')

    def test_localization_preserves_labels_colors_and_reports_missing_cached_media(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'source').mkdir()
            Image.new('RGB', (2, 1), 'blue').save(root / 'original.png')
            body = (root / 'original.png').read_bytes()
            wheel_url = 'https://art.slot-cfw.fyi/GB/wheel/11111111.png'
            original = {'11111111': {'wheel': wheel_url, 'support-texture': 'original.png', 'look': {'deep': '#123456'}}}
            with patch.object(cache.near, 'fetch', return_value=body):
                index, errors = cache.localize_index(root, original, 2, False)
            self.assertEqual(errors, {})
            self.assertTrue((root / index['11111111']['wheel']).is_file())
            self.assertEqual(index['11111111']['look'], original['11111111']['look'])
            self.assertEqual(index['11111111']['support-texture'], 'original.png')
            self.assertEqual(original['11111111']['wheel'], wheel_url)
            with patch.object(cache.near, 'fetch', side_effect=AssertionError('network forbidden')):
                _, errors = cache.localize_index(root, original, 2, True)
                self.assertEqual(errors, {})
                (root / index['11111111']['wheel']).write_bytes(b'corrupt')
                index, errors = cache.localize_index(root, original, 2, True)
                self.assertIn(wheel_url, errors)
                self.assertNotIn('wheel', index['11111111'])


if __name__ == '__main__':
    unittest.main()
