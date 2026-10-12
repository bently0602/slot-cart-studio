"""Which media a cart still needs. Run from tools/: python3 -m unittest test_harvest"""

import tempfile
import unittest
import io
import json
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import harvest


class Snes(unittest.TestCase):
    def test_harvest_falls_back_to_headerless_crc_and_resumes_both_aliases(self):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            card, output = Path(tmp) / 'card', Path(tmp) / 'art'
            rom = card / 'Games' / 'SNES' / 'Game.smc'
            rom.parent.mkdir(parents=True)
            rom.write_bytes(bytes(512) + b'a' * 32768)
            raw, _, _, bare = harvest.rom_job(rom, 'SNES')
            media = [{'type': kind, 'region': 'us', 'url': f'https://example.test/{kind}'}
                     for kind in ['wheel', 'support-texture']]
            stack.enter_context(patch('harvest.sys.argv', ['harvest', '--dat', 'SNES', '--card', str(card), '--out', str(output)]))
            stack.enter_context(patch('harvest.creds', return_value={}))
            stack.enter_context(patch('harvest.check_systems', return_value={'SNES': 4}))
            stack.enter_context(patch('harvest.quota', return_value={'per_day': 100, 'today': 0, 'per_min': 60, 'threads': 1}))
            stack.enter_context(patch('harvest.dat_entries', return_value={bare: 'Game (USA)'}))
            stack.enter_context(patch('harvest.fetch', return_value=b'\x89PNG\r\n\x1a\n' + bytes(256)))
            stack.enter_context(patch('harvest.time.sleep'))
            api = stack.enter_context(patch('harvest.call', side_effect=[None, {'response': {'jeu': {'medias': media}}}]))
            stack.enter_context(redirect_stdout(io.StringIO()))
            harvest.main()
            self.assertEqual([call.args[1]['crc'] for call in api.call_args_list], [raw, bare])
            self.assertEqual(api.call_args_list[1].args[1]['romtaille'], '32768')
            index = json.loads((output / 'index.json').read_text())
            self.assertEqual(index[raw], index[bare])
            self.assertEqual(set(index[raw]), {'wheel', 'support-texture'})
            api.reset_mock()
            harvest.main()
            api.assert_not_called()

    def test_headered_rom_jobs_retain_raw_and_headerless_checksums(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'Game.smc'
            path.write_bytes(b'header'.ljust(512, b'\x00') + b'a' * 32768)
            raw, name, size, bare = harvest.rom_job(path, 'SNES')
            self.assertEqual(raw, harvest.crc32(path))
            self.assertEqual(bare, harvest.crc32(path, 512))
            self.assertNotEqual(raw, bare)
            self.assertEqual(size, 33280)
            self.assertEqual(name, 'Game.smc')
            self.assertIsNone(harvest.rom_job(path, 'GBA')[3])

    def test_snes_skips_unmeasured_look_templates_and_resumes_aliases(self):
        self.assertEqual(harvest.media_for('SNES', ['wheel', 'look', 'support-texture']), ['wheel', 'support-texture'])
        self.assertEqual(harvest.media_for('GB', ['wheel', 'look']), ['wheel', 'look'])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'SNES'
            (root / 'wheel').mkdir(parents=True)
            (root / 'wheel' / 'AAAA0000.png').write_bytes(b'x')
            index = {'BBBB0000': {'wheel': 'SNES/wheel/AAAA0000.png'}}
            self.assertEqual(harvest.todo_for('BBBB0000', ['wheel'], index, root, False), [])


class TodoFor(unittest.TestCase):
    def test_look_is_skipped_once_recorded_unless_relooked(self):
        root = Path(tempfile.mkdtemp())
        (root / 'wheel').mkdir()
        (root / 'wheel' / 'AAAA0000.png').write_bytes(b'x')
        index = {'AAAA0000': {'look': {'ground': '000000', 'band': None, 'sure': True, 'by': 'analysis'}}}
        wanted = ['wheel', 'look']
        self.assertEqual(harvest.todo_for('AAAA0000', wanted, index, root, relook=False), [])
        self.assertEqual(harvest.todo_for('AAAA0000', wanted, index, root, relook=True), ['look'])
        self.assertEqual(harvest.todo_for('BBBB1111', wanted, index, root, relook=False), ['wheel', 'look'])



class WriteIndex(unittest.TestCase):
    def test_the_index_is_compact_and_sorted(self):
        path = Path(tempfile.mkdtemp()) / 'index.json'
        harvest.write_index(path, {'BBBB1111': {'wheel': 'GB/wheel/BBBB1111.png'}, 'AAAA0000': {'look': None}})
        self.assertEqual(
            path.read_text(),
            '{"AAAA0000":{"look":null},"BBBB1111":{"wheel":"GB/wheel/BBBB1111.png"}}',
        )


class RegionsFor(unittest.TestCase):
    def test_a_dump_prefers_its_own_region(self):
        self.assertEqual(harvest.regions_for('Metroid Fusion (USA)'), ('us', 'wor', 'eu', 'jp'))
        self.assertEqual(harvest.regions_for('Metroid Fusion (USA, Australia)'), ('us', 'wor', 'eu', 'jp'))
        self.assertEqual(harvest.regions_for('Metroid Fusion (Japan)'), ('jp', 'us', 'wor', 'eu'))
        self.assertEqual(harvest.regions_for('Metroid Fusion (Europe) (En,Fr,De,Es,It)'), ('eu', 'us', 'wor', 'jp'))
        self.assertEqual(harvest.regions_for('Pokemon - Gelbe Edition (Germany)'), ('de', 'eu', 'us', 'wor', 'jp'))
        self.assertEqual(harvest.regions_for('Tetris (World) (Rev 1)'), ('wor', 'us', 'eu', 'jp'))
        self.assertEqual(harvest.regions_for('E60EC183'), ('us', 'wor', 'eu', 'jp'))

    def test_pick_follows_the_order_it_is_given(self):
        medias = [{'type': 'wheel', 'region': 'us', 'url': 'u'}, {'type': 'wheel', 'region': 'jp', 'url': 'j'}]
        self.assertEqual(harvest.pick(medias, 'wheel')['url'], 'u')
        self.assertEqual(harvest.pick(medias, 'wheel', harvest.regions_for('X (Japan)'))['url'], 'j')
        self.assertEqual(harvest.pick(medias, 'wheel', harvest.regions_for('X (France)'))['url'], 'u')


class Redo(unittest.TestCase):
    def test_redo_asks_for_every_media_again(self):
        root = Path(tempfile.mkdtemp())
        (root / 'wheel').mkdir()
        (root / 'wheel' / 'AAAA0000.png').write_bytes(b'x')
        index = {'AAAA0000': {'look': {'ground': '000000', 'band': None, 'sure': True, 'by': 'analysis'}}}
        self.assertEqual(harvest.todo_for('AAAA0000', ['wheel', 'look'], index, root, relook=False, redo=True), ['wheel', 'look'])


if __name__ == '__main__':
    unittest.main()
