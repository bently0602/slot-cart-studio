import { albumCoverPath } from './card.js';

const MAX_ART = 20 * 1024 * 1024;
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

// Keep only paths to embedded images while scanning, rather than an album library of image bytes.
export async function readAlbum(album, parser, selectCover) {
  if (!parser) ({ parseBlob: parser, selectCover } = await import('./vendor/music-metadata.js'));
  const parts = album.path.split('/');
  let title = null;
  let artist = null;
  let embedded = null;
  for (const track of album.tracks) {
    try {
      const file = await track.file();
      await checkTagSize(file);
      const { common } = await parser(file, { duration: false });
      title ??= text(common.album);
      artist ??= text(common.albumartist) ?? text(common.artist);
      const picture = selectCover(common.picture);
      if (!embedded && picture && picture.data.byteLength <= MAX_ART) embedded = track;
    } catch {
      // Unreadable tracks still make a folder an album, as they do in slot.
    }
  }
  return {
    ...album,
    title: title ?? (parts.length === 2 ? 'Music' : parts.at(-1)),
    artist: artist ?? (parts.length > 3 ? parts.at(-2) : 'Unknown Artist'),
    artwork: album.cover ? { kind: 'local', file: album.cover.file } : embedded ? { kind: 'embedded', track: embedded } : null,
    original: null,
    selected: null,
    loading: true,
    result: null,
    history: { undo: [], redo: [] },
  };
}

async function checkTagSize(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  let offset = 0;
  if (String.fromCharCode(...head.subarray(0, 3)) === 'ID3') {
    const size = ((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127);
    if (size > MAX_ART + 128 * 1024 || size + 10 > file.size) throw new Error('Invalid or oversized audio tags');
    offset = size + 10;
  }
  const magic = new Uint8Array(await file.slice(offset, offset + 4).arrayBuffer());
  if (String.fromCharCode(...magic) !== 'fLaC') return;
  offset += 4;
  const start = offset;
  for (;;) {
    const block = new Uint8Array(await file.slice(offset, offset + 4).arrayBuffer());
    if (block.length !== 4) throw new Error('Truncated FLAC metadata');
    offset += 4 + (block[1] << 16 | block[2] << 8 | block[3]);
    if (offset - start > MAX_ART + 128 * 1024 || offset > file.size) throw new Error('Invalid or oversized audio tags');
    if (block[0] & 128) return;
  }
}

export function coverMime(album) {
  if (album.cover && album.original?.blob) return album.original.blob.type;
  return albumCoverPath(album).toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

export function editCover(album, asset) {
  if (album.selected === asset) return false;
  album.history.undo.push(album.selected);
  album.history.redo = [];
  album.selected = asset;
  album.result = null;
  return true;
}

export function coverHistory(album, action) {
  if (action === 'revert') return editCover(album, album.original);
  const from = action === 'undo' ? album.history.undo : album.history.redo;
  const to = action === 'undo' ? album.history.redo : album.history.undo;
  if (!from.length) return false;
  to.push(album.selected);
  album.selected = from.pop();
  album.result = null;
  return true;
}

export const needsCoverWrite = (album) => !album.loading && !!album.selected && album.selected !== album.original;

// Inspect image dimensions before decoding to respect slot's image limits.
export function imageSize(bytes) {
  if (bytes.length >= 24 && bytes.slice(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), mime: 'image/png' };
  }
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Choose a JPEG or PNG image');
  for (let at = 2; at + 8 < bytes.length;) {
    if (bytes[at++] !== 255) throw new Error('Invalid JPEG image');
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    const size = bytes[at] * 256 + bytes[at + 1];
    if (size < 2 || at + size > bytes.length) break;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      return { width: bytes[at + 5] * 256 + bytes[at + 6], height: bytes[at + 3] * 256 + bytes[at + 4], mime: 'image/jpeg' };
    }
    at += size;
  }
  throw new Error('Invalid JPEG image');
}

export async function prepareCover(blob, mime = 'image/jpeg') {
  if (blob.size > MAX_ART) throw new Error('This cover exceeds the 20 MiB image limit');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { width, height, mime: originalMime } = imageSize(bytes);
  if (mime === 'original') mime = originalMime;
  if (!width || !height || width > 4096 || height > 4096 || width * height * 4 > 64 * 1024 * 1024) {
    throw new Error('This cover exceeds the 4096-pixel image limit');
  }
  const image = await createImageBitmap(blob);
  try {
    // The bitmap includes JPEG orientation, which can swap the stored dimensions.
    const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const output = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.9));
    if (!output) throw new Error('Could not convert this cover');
    return { blob: output, bytes: new Uint8Array(await output.arrayBuffer()) };
  } finally {
    image.close();
  }
}

export async function existingCover(album) {
  if (!album.artwork) return null;
  let blob;
  if (album.artwork.kind === 'local') blob = await album.artwork.file();
  else {
    const { parseBlob, selectCover } = await import('./vendor/music-metadata.js');
    const file = await album.artwork.track.file();
    await checkTagSize(file);
    const { common } = await parseBlob(file, { duration: false });
    const art = selectCover(common.picture);
    if (!art) return null;
    blob = new Blob([art.data], { type: art.format });
  }
  return prepareCover(blob, album.artwork.kind === 'local' ? 'original' : coverMime(album));
}

export function coverUrl(id, size) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid album identifier');
  return `https://coverartarchive.org/release-group/${id}/front-${size}`;
}

export async function fetchCover(id, size, signal) {
  const response = await fetch(coverUrl(id, size), { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cover service returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_ART) throw new Error('Cover exceeds the image limit');
  // Stop oversized streams before buffering them, even without a Content-Length header.
  const reader = response.body.getReader();
  const chunks = [];
  let sizeRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      sizeRead += value.byteLength;
      if (sizeRead > MAX_ART) { await reader.cancel(); throw new Error('Cover exceeds the image limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('content-type') ?? 'image/jpeg' });
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export async function searchAlbums(base, artist, album, signal) {
  const url = new URL('search', base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('album', album.trim());
  url.searchParams.set('artist', artist.trim() === 'Unknown Artist' ? '' : artist.trim());
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { signal });
    if ([429, 503].includes(response.status) && attempt < 2) {
      const seconds = Number(response.headers.get('retry-after')) || 2;
      if (seconds <= 10) { await pause(Math.max(1, seconds) * 1000, signal); continue; }
    }
    if (!response.ok) throw new Error(`Album search is unavailable (HTTP ${response.status}). Try again or import a cover.`);
    const data = await response.json();
    if (!Array.isArray(data.candidates)) throw new Error('Album search returned an invalid response');
    return data.candidates.slice(0, 8);
  }
}
