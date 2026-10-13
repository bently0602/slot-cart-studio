import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('near', Path(__file__).with_name('harvest-near.py'))
near = importlib.util.module_from_spec(spec)
spec.loader.exec_module(near)


def game(name, crc):
    return f'game (\n name "{name}"\n rom ( crc {crc} )\n)\n'


class NearTrialTests(unittest.TestCase):
    def test_aliases_and_punctuation_match_without_guessing_sequels(self):
        titles = {'Mighty Max': {}, "Donkey Kong Country 2 - Diddy's Kong Quest": {},
                  'Fun Games': {}, 'Fun & Games': {}}
        self.assertEqual(near.match_title(titles, 'Adventures of Mighty Max, The',
                                          {'Adventures of Mighty Max, The': 'Mighty Max'}), 'Mighty Max')
        self.assertEqual(near.match_title(titles, 'Donkey Kong Country 2 - Diddy_s Kong Quest', {}),
                         "Donkey Kong Country 2 - Diddy's Kong Quest")
        for title in ('Donkey Kong Country', 'Fun_Games'):
            with self.assertRaises(ValueError):
                near.match_title(titles, title, {})

    def test_retail_regions_revisions_and_title_are_exact(self):
        dat = ''.join(game(name, f'{i:08x}') for i, name in enumerate([
            'Donkey Kong Country (USA)', 'Donkey Kong Country (USA) (Rev 1)',
            'Donkey Kong Country (Europe)', 'Donkey Kong Country 2 (USA)',
            'Donkey Kong Country (USA) (Beta)',
            'Donkey Kong Country (USA, Europe) (Virtual Console)',
        ]))
        self.assertEqual(set(near.usa_matches(dat, 'Donkey Kong Country')), {'00000000', '00000001'})
        self.assertEqual(near.usa_matches(game('Super Metroid (Japan, USA) (En,Ja)', 'd63ed5f8'),
                                         'Super Metroid'), {'D63ED5F8': 'Super Metroid (Japan, USA) (En,Ja)'})

    def test_unmatched_title_does_not_silently_import(self):
        with self.assertRaises(ValueError):
            near.usa_matches(game('Chrono Trigger (Japan)', '4D014C20'), 'Chrono Trigger')

    def test_hosted_media_and_measurements_survive_local_override(self):
        old = {'12345678': {'wheel': 'GBA/wheel/12345678.png',
                           'support-texture': 'https://other.example/texture.png',
                           'look': {'deep': '#123456'}}}
        rebased = near.rebase_index(old, near.HOSTED)
        self.assertEqual(rebased['12345678']['wheel'], near.HOSTED + 'GBA/wheel/12345678.png')
        self.assertEqual(rebased['12345678']['support-texture'], 'https://other.example/texture.png')
        self.assertEqual(rebased['12345678']['look'], old['12345678']['look'])
        self.assertEqual(old['12345678']['wheel'], 'GBA/wheel/12345678.png')

    def test_corrupt_download_keeps_original_cache(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'scan.png'
            original = b'original scan'
            path.write_bytes(original)
            with patch.object(near, 'fetch', side_effect=AssertionError('must use verified cache')):
                near.verified_scan(path, 'https://example.test/scan', hashlib.sha1(original).hexdigest())
            with patch.object(near, 'fetch', return_value=b'corrupt scan'):
                with self.assertRaises(ValueError):
                    near.verified_scan(path, 'https://example.test/scan', '0' * 40)
            self.assertEqual(path.read_bytes(), original)

    def test_crop_removes_surroundings_and_preserves_printed_proportions(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / 'source.png', Path(folder) / 'label.png'
            scan = Image.new('RGB', (20, 30), 'red')
            scan.paste('blue', (4, 4, 10, 28))
            scan.save(source)
            near.prepare_label(source, output, {'size': [20, 30], 'crop': [4, 4, 10, 28]})
            with Image.open(output) as label:
                self.assertEqual(label.size, (960, 584))
                self.assertEqual(label.getpixel((480, 292)), (0, 0, 255))
                self.assertEqual(label.getpixel((480, 0)), (0, 0, 0))
                self.assertNotIn((255, 0, 0), {pixel for _, pixel in label.getcolors(960 * 584)})

    def test_full_cli_checkpoints_failures_and_resumes_offline(self):
        import hashlib
        import json
        import subprocess
        import sys
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'
            source.mkdir()
            catalog = {}
            for name, color in [('First Game', 'blue'), ('Second Game', 'green')]:
                slug = name.replace(' ', '-')
                scan = source / (slug + '.png')
                Image.new('RGB', (20, 30), color).save(scan)
                catalog[name] = {'slug': slug, 'sha1': hashlib.sha1(scan.read_bytes()).hexdigest(),
                                 'size': [20, 30], 'crop': [4, 4, 10, 28]}
            catalog_path = root / 'catalog.json'
            catalog_path.write_text(json.dumps(catalog))
            (source / 'snes.dat').write_text(game('First Game (USA)', '11111111') +
                                            game('Second Game (USA)', '22222222'))
            (source / 'hosted-index.json').write_text(json.dumps({
                '33333333': {'wheel': 'GB/wheel/33333333.png'},
                '11111111': {'wheel': 'SNES/wheel/11111111.png'}}))
            missing = source / 'Second-Game.png'
            original = missing.read_bytes()
            missing.write_bytes(b'corrupt scan')
            cmd = [sys.executable, str(near.CATALOG.with_name('harvest-near.py')), '--all',
                   '--catalog', str(catalog_path), '--out', str(root), '--offline', '--jobs', '2']
            first = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(first.returncode, 1, first.stderr)
            coverage = json.loads((root / 'coverage.json').read_text())
            self.assertEqual(coverage['completed'], 1)
            self.assertIn('Second Game', coverage['failed'])
            index = json.loads((root / 'index.json').read_text())
            self.assertTrue((root / index['11111111']['support-texture']).is_file())
            self.assertEqual(index['11111111']['wheel'], near.HOSTED + 'SNES/wheel/11111111.png')
            self.assertEqual(index['33333333']['wheel'], near.HOSTED + 'GB/wheel/33333333.png')
            missing.write_bytes(original)
            second = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            coverage = json.loads((root / 'coverage.json').read_text())
            self.assertEqual(coverage['completed'], 2)
            self.assertEqual(coverage['failed'], {})
            self.assertEqual(coverage['available_checksums'], 2)


if __name__ == '__main__':
    unittest.main()
