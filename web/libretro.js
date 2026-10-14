// libretro's databases and thumbnails, both from raw.githubusercontent.com, which answers
// cross-origin requests. thumbnails.libretro.com serves the same images and sends no
// access-control-allow-origin header at all, so a page can fetch it and still not read a byte.

const DAT = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/';
const THUMBS = 'https://raw.githubusercontent.com/libretro-thumbnails/';

// One database and one thumbnail repository per platform, under libretro's own name for the
// system: spaces in the database file, underscores in the repository. The platform is the card
// folder a rom sits in, so a .gbc filed under GB is looked up in the Game Boy database — slot
// decides a platform by where a file is, and the studio does not second-guess it by extension.
const NAMES = {
  GBA: 'Nintendo - Game Boy Advance',
  GB: 'Nintendo - Game Boy',
  GBC: 'Nintendo - Game Boy Color',
  PSX: 'Sony - PlayStation',
  SNES: 'Nintendo - Super Nintendo Entertainment System',
};
// Cartridges are catalogued by No-Intro; discs are Redump's.
const SETS = { PSX: 'redump' };

export async function fetchDat(platform, library = null) {
  const path = library?.platforms[platform]?.database;
  if (library && !path) throw new Error(`The local library has no ${platform} database; update it first.`);
  const r = await fetch(library ? localUrl(library.base, path) : `${DAT}${SETS[platform] ?? 'no-intro'}/${encodeURIComponent(NAMES[platform])}.dat`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// A card can hold hundreds of carts, each wanting two images, and GitHub is not a CDN.
export function limiter(slots) {
  let running = 0;
  const waiting = [];
  const pump = () => {
    while (running < slots && waiting.length) {
      const { job, resolve, reject } = waiting.shift();
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return (job) =>
    new Promise((resolve, reject) => {
      waiting.push({ job, resolve, reject });
      pump();
    });
}

// A set of our own, hosted as static files: <platform>/<media>/<CRC32>.png, with an index.json
// mapping a rom's checksum to what it holds. Looked up by checksum rather than by name, so it
// needs no agreement about spelling and reaches roms No-Intro has never heard of. It is a
// separate origin from the page, so whatever serves it has to allow the read.
export async function fetchIndex(base) {
  const r = await fetch(new URL('index.json', base));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchArt(base, path, localOnly = false) {
  const r = await fetch(localOnly ? localUrl(base, path) : new URL(path, base));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// A thumbnail's bytes, or null when libretro has none. A git symlink comes back as a one-line
// body naming its target in the same folder; `stubTarget`, from the Rust side, tells the two apart.
export async function fetchThumb(platform, folder, name, stubTarget, library = null) {
  if (library) {
    const path = library.platforms[platform]?.thumbnails?.[folder]?.[name];
    if (path) return fetchArt(library.base, path, true);
    if (library.onDemand && library.platforms[platform] && ['Named_Boxarts', 'Named_Logos'].includes(folder)) {
      return fetchArt(library.base, `thumbnails/${platform}/${folder}/${encodeURIComponent(name + '.png')}`, true);
    }
    return null;
  }
  const repo = NAMES[platform].replaceAll(' ', '_');
  const get = async (file) => {
    const r = await fetch(`${THUMBS}${repo}/master/${folder}/${encodeURIComponent(file)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const body = await get(`${name}.png`);
  if (!body) return null;
  const target = stubTarget(body);
  return target === undefined ? body : get(target);
}

function localUrl(base, path) {
  const root = new URL(base);
  const url = new URL(path, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new Error('This artwork library contains a nonlocal file path; update the library.');
  }
  return url;
}

export async function fetchLibrary(base) {
  const r = await fetch(new URL('library.json', base));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const library = await r.json();
  if (library.version !== 1 || library.offline !== true || !library.platforms) {
    throw new Error('Unsupported local artwork library');
  }
  return { ...library, base };
}
