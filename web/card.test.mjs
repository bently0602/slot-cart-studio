import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumCoverPath, fromDirectory, fromFiles, shelved } from './card.js';

const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });

const dirHandle = (tree) => ({
  kind: 'directory',
  async getDirectoryHandle(name) {
    if (typeof tree[name] !== 'object') throw notFound();
    return dirHandle(tree[name]);
  },
  async getFileHandle(name) {
    if (typeof tree[name] !== 'string') throw notFound();
    return fileHandle(tree[name]);
  },
  async *entries() {
    for (const [name, value] of Object.entries(tree)) {
      yield [name, typeof value === 'object' ? dirHandle(value) : fileHandle(value)];
    }
  },
});
const fileHandle = (text) => ({ kind: 'file', getFile: async () => new File([text], 'f') });

const listed = (tree, prefix = 'card') =>
  Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'object'
      ? listed(value, `${prefix}/${name}`)
      : [Object.assign(new File([value], name), { webkitRelativePath: `${prefix}/${name}` })],
  );

const GAMES = { Games: { GBA: { 'A.gba': '' } } };

test('both card readers scan SNES extensions and recursive folder-defined albums', async () => {
  const tree = { Games: {
    SNES: { 'A.sfc': '', 'B.SMC': '', 'C.swc': '', 'D.fig': '', 'skip.bin': '', '.hidden.sfc': '' },
    Music: { 'Root.mp3': '', '.hidden': { 'no.mp3': '' },
      'Artist é': { Same: { '10.flac': '', '2.MP3': '', 'cover.png': '', 'COVER.JPG': '', 'cover.jpeg': '',
        'Disc 2': { 'one.mp3': '' } } }, Other: { Same: { 'one.mp3': '' } } },
  }, Labels: { SNES: { 'A.png': '' } } };
  for (const source of [await fromDirectory(dirHandle(tree)), fromFiles(listed(tree))]) {
    assert.deepEqual(source.carts.map((c) => c.name), ['A.sfc', 'B.SMC', 'C.swc', 'D.fig']);
    assert.equal(source.labels.size, 1);
    assert.equal(source.albums.length, 4);
    const album = source.albums.find((a) => a.path === 'Games/Music/Artist é/Same');
    assert.deepEqual(album.tracks.map((t) => t.name), ['2.MP3', '10.flac']);
    assert.equal(album.cover.name, 'COVER.JPG');
    assert.equal(albumCoverPath(album), 'Games/Music/Artist é/Same/COVER.JPG');
  }
});

test('music-only cards are accepted by both readers', async () => {
  const tree = { Games: { Music: { Album: { 'track.flac': '' } } } };
  for (const source of [await fromDirectory(dirHandle(tree)), fromFiles(listed(tree))]) {
    assert.equal(source.carts.length, 0);
    assert.equal(source.albums.length, 1);
    assert.equal(albumCoverPath(source.albums[0]), 'Games/Music/Album/cover.jpg');
  }
});

test('cover write failures preserve replacements and remove newly created incomplete files', async () => {
  for (const failure of ['create', 'write', 'close']) {
  for (const existing of [false, true]) {
    const name = existing ? 'COVER.PNG' : 'cover.jpg';
    const files = new Map(existing ? [[name, 'old cover']] : []);
    const removed = [];
    let aborts = 0;
    const tree = { Games: { Music: { Album: { 'one.mp3': '', ...(existing ? { [name]: 'old cover' } : {}) } } } };
    const basic = dirHandle(tree);
    const target = {
      async getFileHandle(file, options = {}) {
        if (!files.has(file)) {
          if (!options.create) throw notFound();
          files.set(file, '');
        }
        return { async createWritable() {
          if (failure === 'create') throw new Error('card full');
          return {
          async write() { if (failure === 'write') throw new Error('card full'); },
          async close() { if (failure === 'close') throw new Error('card full'); }, async abort() { aborts++; },
        }; } };
      },
      async removeEntry(file) { removed.push(file); files.delete(file); },
    };
    const root = { ...basic, async getDirectoryHandle(dir) {
      if (dir !== 'Games') return basic.getDirectoryHandle(dir);
      const games = await basic.getDirectoryHandle(dir);
      return { ...games, async getDirectoryHandle(music) {
        const m = await games.getDirectoryHandle(music);
        return { ...m, getDirectoryHandle: async () => target };
      } };
    } };
    const source = await fromDirectory(root);
    await assert.rejects(source.writeCover(source.albums[0], new Uint8Array([1]), existing), /card full/);
    assert.equal(aborts, failure === 'create' ? 0 : 1);
    assert.deepEqual(removed, existing ? [] : [name]);
    assert.equal(files.get(name), existing ? 'old cover' : undefined);
    await assert.rejects(source.writeCover({ path: 'Games/Music/../Album', cover: null }, new Uint8Array()), /Invalid music cover path/);
  }
  }
});
const CONFIG = 'A = rounded 112233 solid\n';
const SYSTEM = 'A = notched 445566 clear\n';
const LABELS = 'A = auto\n';

const layers = async (source) => ({ system: await source.systemShells(), labels: await source.labelShells() });
const both = async (tree) => [await layers(await fromDirectory(dirHandle(tree))), await layers(fromFiles(listed(tree)))];

test('a card slot has moved reads its shells from Config', async () => {
  for (const got of await both({ ...GAMES, Config: { 'cart_shell.txt': CONFIG }, Labels: { 'cart_shell.txt': LABELS } })) {
    assert.deepEqual(got, { system: CONFIG, labels: LABELS });
  }
});

test('a card slot has not moved yet reads its shells from System', async () => {
  for (const got of await both({ ...GAMES, System: { 'cart_shell.ini': SYSTEM } })) {
    assert.deepEqual(got, { system: SYSTEM, labels: '' });
  }
});

test('Config wins over a System file left behind', async () => {
  for (const got of await both({ ...GAMES, Config: { 'cart_shell.txt': CONFIG }, System: { 'cart_shell.ini': SYSTEM } })) {
    assert.deepEqual(got, { system: CONFIG, labels: '' });
  }
});

test('an empty Config file is still the one slot reads', async () => {
  for (const got of await both({ ...GAMES, Config: { 'cart_shell.txt': '' }, System: { 'cart_shell.ini': SYSTEM } })) {
    assert.deepEqual(got, { system: '', labels: '' });
  }
});

test('a Config folder without the file falls back to System', async () => {
  for (const got of await both({ ...GAMES, Config: {}, System: { 'cart_shell.ini': SYSTEM } })) {
    assert.deepEqual(got, { system: SYSTEM, labels: '' });
  }
});

test('a card with no shell files reads as empty', async () => {
  for (const got of await both(GAMES)) {
    assert.deepEqual(got, { system: '', labels: '' });
  }
});

test('a Config file the browser refuses fails only its own layer', async () => {
  const refused = Object.assign(new Error('could not be read'), { name: 'NotReadableError' });
  const card = dirHandle({ ...GAMES, Config: { 'cart_shell.txt': CONFIG }, Labels: { 'cart_shell.txt': LABELS } });
  const config = await card.getDirectoryHandle('Config');
  const source = await fromDirectory({
    ...card,
    async getDirectoryHandle(name) {
      if (name !== 'Config') return card.getDirectoryHandle(name);
      return { ...config, getFileHandle: async () => ({ kind: 'file', getFile: async () => Promise.reject(refused) }) };
    },
  });
  await assert.rejects(source.systemShells(), { name: 'NotReadableError' });
  assert.equal(await source.labelShells(), LABELS);
});

test('a card slot has not started on since the rename reads its .ini shells', async () => {
  for (const got of await both({ ...GAMES, Config: { 'cart_shell.ini': CONFIG }, Labels: { 'cart_shell.ini': LABELS } })) {
    assert.deepEqual(got, { system: CONFIG, labels: LABELS });
  }
});

test('a .txt wins over the .ini beside it', async () => {
  const tree = {
    ...GAMES,
    Config: { 'cart_shell.ini': SYSTEM, 'cart_shell.txt': CONFIG },
    Labels: { 'cart_shell.ini': SYSTEM, 'cart_shell.txt': LABELS },
  };
  for (const got of await both(tree)) {
    assert.deepEqual(got, { system: CONFIG, labels: LABELS });
  }
});

test('an .ini the browser will not open by name asks for slot to start once', async () => {
  const card = dirHandle({ ...GAMES, Labels: { 'cart_shell.ini': LABELS } });
  const labels = await card.getDirectoryHandle('Labels');
  const source = await fromDirectory({
    ...card,
    async getDirectoryHandle(name) {
      if (name !== 'Labels') return card.getDirectoryHandle(name);
      return {
        ...labels,
        async getFileHandle(file) {
          if (file.endsWith('.ini')) throw new TypeError('Name is not allowed.');
          return labels.getFileHandle(file);
        },
      };
    },
  });
  await assert.rejects(source.labelShells(), { name: 'OldShellFile' });
});

test('shells are written to Labels/cart_shell.txt', async () => {
  const written = {};
  const card = dirHandle({ ...GAMES, Labels: {} });
  const source = await fromDirectory({
    ...card,
    async getDirectoryHandle(name) {
      if (name !== 'Labels') return card.getDirectoryHandle(name);
      return {
        async getFileHandle(file) {
          return {
            async createWritable() {
              return { write: async (t) => (written[`${name}/${file}`] = t), close: async () => {} };
            },
          };
        },
      };
    },
  });
  await source.writeShells(LABELS);
  assert.deepEqual(written, { 'Labels/cart_shell.txt': LABELS });
});

test('a listed card carries every file in its Labels folder but dotfiles', async () => {
  const source = fromFiles(
    listed({
      ...GAMES,
      labels: {
        'cart_shell.txt': LABELS,
        '.DS_Store': '',
        GBA: { 'A.png': 'a', 'Gone.png': 'g', '._A.png': '' },
        Odd: { 'note.txt': 'n' },
      },
      Saves: { GBA: { 'A.sav': '' } },
    }),
  );
  const got = await Promise.all(source.labelFiles.map(async (f) => [f.path, await (await f.file()).text()]));
  assert.deepEqual(got, [
    ['Labels/cart_shell.txt', LABELS],
    ['Labels/GBA/A.png', 'a'],
    ['Labels/GBA/Gone.png', 'g'],
    ['Labels/Odd/note.txt', 'n'],
  ]);
});

const DISCS = {
  Games: {
    PSX: {
      'Adventure.m3u': '# both discs\r\nAdventure (Disc 1).chd\r\n./adventure (disc 2).CHD\r\n',
      'Adventure (Disc 1).chd': '',
      'Adventure (Disc 2).chd': '',
      'Racer.cue': '',
      'Racer.bin': '',
      'Homebrew.exe': '',
      '._Racer.cue': '',
      'Pak.gba': '',
    },
  },
  Labels: { PSX: { 'Racer.png': 'r' } },
};

test('PlayStation discs are carts, and a .cue’s tracks are not', async () => {
  for (const source of [await fromDirectory(dirHandle(DISCS)), fromFiles(listed(DISCS))]) {
    assert.deepEqual(
      source.carts.map((c) => `${c.platform}/${c.name}`),
      ['PSX/Adventure.m3u', 'PSX/Adventure (Disc 1).chd', 'PSX/Adventure (Disc 2).chd', 'PSX/Homebrew.exe', 'PSX/Racer.cue'],
    );
    assert.deepEqual([...source.labels.keys()], ['PSX/Racer']);
  }
});

test('a playlist is shelved in place of the discs it names', async () => {
  for (const source of [await fromDirectory(dirHandle(DISCS)), fromFiles(listed(DISCS))]) {
    assert.deepEqual(
      (await shelved(source.carts)).map((c) => c.name),
      ['Adventure.m3u', 'Homebrew.exe', 'Racer.cue'],
    );
  }
});

test('a playlist that cannot be read hides nothing, and carts are never hidden', async () => {
  const carts = [
    { platform: 'PSX', name: 'A.m3u', file: () => Promise.reject(new Error('gone')) },
    { platform: 'PSX', name: 'A (Disc 1).chd', file: async () => new File([''], 'f') },
    { platform: 'PSX', name: 'B.m3u', file: async () => new File(['Pak.gba\n'], 'f') },
    { platform: 'GBA', name: 'Pak.gba', file: async () => new File([''], 'f') },
  ];
  assert.deepEqual(await shelved(carts), carts);
});

test('a folder the browser listed as empty says it could not be read', () => {
  assert.throws(() => fromFiles([]), /couldn’t read that folder/);
});

test('a folder with files but no games is still not a slot card', () => {
  assert.throws(() => fromFiles(listed({ Photos: { 'a.jpg': '' } })), /doesn’t look like a compatible SD card/);
});
