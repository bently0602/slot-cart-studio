// A card, however the browser opened it. Chrome and Edge hand over a directory handle that can
// be written to. Everything else hands over a flat list of files with their paths, which can only
// be read, so the labels leave as a zip instead.

// slot files a cart under the folder its platform names, in Games/, Labels/, Saves/ and States/
// alike, and the folder is what decides the platform: the rom is never opened to ask.
// The handhelds newest first, then the PlayStation, which is the order the studio's shelves and
// tabs run in.
export const PLATFORMS = ['GBA', 'GBC', 'GB', 'PSX', 'SNES'];

// slot's own rule, from slot-store's platform.rs. A .gba under GB/ is not a Game Boy cart and is
// passed over in silence, the way slot passes over it. A .cue's .bin tracks are passed over too.
const EXTENSIONS = {
  GBA: ['gba'],
  GB: ['gb', 'gbc'],
  GBC: ['gb', 'gbc'],
  PSX: ['chd', 'cue', 'pbp', 'iso', 'exe', 'm3u'],
  SNES: ['sfc', 'smc', 'swc', 'fig'],
};
const ANY_ROM = ['gba', 'gb', 'gbc', 'sfc', 'smc', 'swc', 'fig'];

const named = (dir) => PLATFORMS.find((p) => p === dir.toUpperCase());
const ext = (name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
// Never a dotfile: macOS leaves `._` sidecars beside what it copies onto a card, extension and
// all, so the extension alone cannot tell them from the file they shadow.
const visible = (name) => !name.startsWith('.');
const isCart = (platform, name) => visible(name) && EXTENSIONS[platform].includes(ext(name));
const isRom = (name) => visible(name) && ANY_ROM.includes(ext(name));
const isLabel = (name) => visible(name) && ext(name) === 'png';
const stemOf = (name) => name.slice(0, name.lastIndexOf('.'));

// Music is a shelf of folder-defined albums, not an emulator platform.
const musicFile = (name) => visible(name) && ['mp3', 'flac'].includes(ext(name));
const safePart = (part) => !!part && part !== '.' && part !== '..' && !part.includes('\\') && visible(part);

function albumFromFiles(path, files) {
  const tracks = files.filter((f) => musicFile(f.name)).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!tracks.length) return null;
  const cover = ['cover.jpg', 'cover.jpeg', 'cover.png'].map((name) =>
    files.find((f) => f.name.toLowerCase() === name)).find(Boolean) ?? null;
  return { path, tracks, cover };
}

async function musicDirectories(dir, path, albums) {
  const files = [];
  for await (const [name, handle] of dir.entries()) {
    if (!safePart(name)) continue;
    if (handle.kind === 'directory') await musicDirectories(handle, `${path}/${name}`, albums);
    else if (handle.kind === 'file') files.push({ name, file: () => handle.getFile() });
  }
  const album = albumFromFiles(path, files);
  if (album) albums.push(album);
}

export function albumCoverPath(album) {
  return `${album.path}/${album.cover?.name ?? 'cover.jpg'}`;
}

// File System Access commits replacements on close. On failure only a newly created file is removed.
async function writeFile(dir, name, bytes, replace) {
  let existed = false;
  try {
    await dir.getFileHandle(name);
    existed = true;
    if (!replace) return 'skipped';
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
  const file = await dir.getFileHandle(name, { create: true });
  let out;
  try {
    out = await file.createWritable();
    await out.write(bytes);
    await out.close();
  } catch (e) {
    await out?.abort().catch(() => {});
    if (!existed) await dir.removeEntry(name).catch(() => {});
    throw e;
  }
  return 'written';
}

// macOS lists exFAT names decomposed, whatever form was written, so names are compared composed.
// What gets written is still the listing's own spelling. The platform is part of the key because
// a .gb and a .gba can share a stem — two different games, two different carts.
const labelKey = (platform, stem) => `${platform}/${stem.normalize('NFC')}`;
const byCart = (a, b) =>
  a.platform !== b.platform
    ? PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform)
    : a.stem < b.stem
      ? -1
      : a.stem > b.stem
        ? 1
        : 0;

// slot shelves a PlayStation playlist as one game and hides the discs it names, which share its
// label. A playlist that can't be read hides nothing.
const fold = (name) => name.normalize('NFC').toLowerCase();
export async function shelved(carts) {
  const isPlaylist = (c) => c.platform === 'PSX' && ext(c.name) === 'm3u';
  const discs = new Set();
  for (const c of carts.filter(isPlaylist)) {
    let text = '';
    try {
      text = await (await c.file()).text();
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
      if (line && !line.startsWith('#')) discs.add(fold(line.replace(/^\.[\\/]/, '')));
    }
  }
  return carts.filter((c) => c.platform !== 'PSX' || isPlaylist(c) || !discs.has(fold(c.name)));
}

const NO_GAMES ='That doesn’t look like a slot SD card. Be sure to select the root of the card.';
const UNREADABLE =
  'Your browser couldn’t read that folder. In Firefox, the card’s hidden .Spotlight-V100 folder or a file with an accented name like é can cause this.';
const OLD_SHELL_FILE =
  'This browser can’t open cart_shell.ini. Start the latest slot once, then choose the card again.';
const OLD_LAYOUT =
  'This card still keeps its roms loose in Games. Start slot once on the device to sweep them into GBA, GB and GBC folders, then choose the card again.';

export async function fromDirectory(root) {
  let games;
  try {
    games = await root.getDirectoryHandle('Games');
  } catch {
    throw new Error(NO_GAMES);
  }
  const carts = [];
  const albums = [];
  let sawPlatform = false;
  let loose = false;
  for await (const [name, handle] of games.entries()) {
    if (handle.kind === 'directory' && name.toLowerCase() === 'music') {
      sawPlatform = true;
      await musicDirectories(handle, `Games/${name}`, albums);
      continue;
    }
    const platform = handle.kind === 'directory' ? named(name) : null;
    if (!platform) {
      if (handle.kind === 'file' && isRom(name)) loose = true;
      continue;
    }
    sawPlatform = true;
    for await (const [file, fh] of handle.entries()) {
      if (fh.kind === 'file' && isCart(platform, file)) {
        carts.push({ platform, stem: stemOf(file), name: file, file: () => fh.getFile() });
      }
    }
  }
  // A card swept by slot has the folders. One that has roms but no folders predates the sweep,
  // and slot does that sweep itself on the device rather than the studio doing it over the wire.
  if (!sawPlatform && loose) throw new Error(OLD_LAYOUT);

  const labels = new Map();
  try {
    const dir = await root.getDirectoryHandle('Labels');
    for await (const [name, handle] of dir.entries()) {
      const platform = handle.kind === 'directory' ? named(name) : null;
      if (!platform) continue;
      for await (const [file, fh] of handle.entries()) {
        if (fh.kind === 'file' && isLabel(file)) {
          labels.set(labelKey(platform, stemOf(file)), () => fh.getFile());
        }
      }
    }
  } catch {
    // No Labels folder yet: every cart needs a label.
  }

  const shellFile = async (folder) => {
    let dir;
    try {
      dir = await root.getDirectoryHandle(folder);
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
    const read = async (name) => {
      try {
        return await (await (await dir.getFileHandle(name)).getFile()).text();
      } catch (e) {
        if (e.name === 'NotFoundError') return null;
        throw e;
      }
    };
    const txt = await read('cart_shell.txt');
    if (txt !== null) return txt;
    try {
      return await read('cart_shell.ini');
    } catch (e) {
      if (e.name !== 'TypeError') throw e;
      throw Object.assign(new Error(OLD_SHELL_FILE, { cause: e }), { name: 'OldShellFile' });
    }
  };
  const systemShells = async () => (await shellFile('Config')) ?? (await shellFile('System')) ?? '';
  const labelShells = async () => (await shellFile('Labels')) ?? '';

  return {
    carts: carts.sort(byCart),
    albums: albums.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
    labels,
    direct: true,
    systemShells,
    labelShells,
    async writeCover(album, bytes, replace = false) {
      const path = albumCoverPath(album).split('/');
      if (path[0] !== 'Games' || path[1].toLowerCase() !== 'music' || !path.every(safePart)) {
        throw new Error('Invalid music cover path');
      }
      let dir = root;
      for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return writeFile(dir, path.at(-1), bytes, replace);
    },
    async writeShells(text) {
      const dir = await root.getDirectoryHandle('Labels', { create: true });
      const file = await dir.getFileHandle('cart_shell.txt', { create: true });
      const out = await file.createWritable();
      try {
        await out.write(text);
        await out.close();
      } catch (e) {
        await out.abort().catch(() => {});
        throw e;
      }
    },
    // A label already on the card is skipped unless `replace` says to write over it.
    async write(platform, stem, bytes, replace = false) {
      const root_dir = await root.getDirectoryHandle('Labels', { create: true });
      const dir = await root_dir.getDirectoryHandle(platform, { create: true });
      const name = `${stem}.png`;
      return writeFile(dir, name, bytes, replace);
    },
  };
}

export function fromFiles(files) {
  if (files.length === 0) throw new Error(UNREADABLE);
  const carts = [];
  const labels = new Map();
  const labelFiles = [];
  const musicFolders = new Map();
  let sawPlatform = false;
  let loose = false;
  const shellFiles = {};
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length >= 4 && parts[1].toLowerCase() === 'games' && parts[2].toLowerCase() === 'music') {
      if (!parts.slice(2).every(safePart)) continue;
      sawPlatform = true;
      const path = ['Games', ...parts.slice(2, -1)].join('/');
      if (!musicFolders.has(path)) musicFolders.set(path, []);
      musicFolders.get(path).push({ name: parts.at(-1), file: async () => file });
      continue;
    }
    if (parts.length >= 3 && parts[1].toLowerCase() === 'labels' && parts.slice(2).every(visible)) {
      labelFiles.push({ path: ['Labels', ...parts.slice(2)].join('/'), file: async () => file });
    }
    // The picked folder, then Games or Labels, then the platform, then the file. Anything
    // shallower is the layout slot swept away; anything deeper is not slot's.
    if (parts.length === 3) {
      const [, dir, name] = parts;
      if (dir.toLowerCase() === 'games' && isRom(name)) loose = true;
      const ext = ['cart_shell.txt', 'cart_shell.ini'].indexOf(name.toLowerCase());
      if (['config', 'system', 'labels'].includes(dir.toLowerCase()) && ext !== -1) {
        (shellFiles[dir.toLowerCase()] ??= [])[ext] = file;
      }
      continue;
    }
    if (parts.length !== 4) continue;
    const [, dir, folder, name] = parts;
    const platform = named(folder);
    if (!platform) continue;
    if (dir.toLowerCase() === 'games') {
      sawPlatform = true;
      if (isCart(platform, name)) carts.push({ platform, stem: stemOf(name), name, file: async () => file });
    } else if (dir.toLowerCase() === 'labels' && isLabel(name)) {
      labels.set(labelKey(platform, stemOf(name)), async () => file);
    }
  }
  if (!sawPlatform) throw new Error(loose ? OLD_LAYOUT : NO_GAMES);
  const text = async (files) => {
    const file = files?.[0] ?? files?.[1];
    return file ? file.text() : '';
  };
  return {
    carts: carts.sort(byCart),
    albums: [...musicFolders].map(([path, files]) => albumFromFiles(path, files)).filter(Boolean)
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
    labels,
    labelFiles,
    direct: false,
    write: null,
    writeCover: null,
    systemShells: () => text(shellFiles.config ?? shellFiles.system),
    labelShells: () => text(shellFiles.labels),
  };
}

export { labelKey };
