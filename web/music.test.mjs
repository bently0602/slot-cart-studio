import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlob, selectCover } from 'music-metadata';
import { readFile } from 'node:fs/promises';
import { coverHistory, coverMime, coverUrl, editCover, fetchCover, imageSize, needsCoverWrite, readAlbum, searchAlbums } from './music.js';
import { albumCoverPath } from './card.js';
const track = (name) => ({ name, file: async () => new File(['corrupt'], name) });
test('corrupt tracks fall back to folders and duplicate titles remain separate', async () => {
  const parser = async () => { throw new Error('corrupt'); };
  const root = await readAlbum({ path: 'Games/Music', tracks: [track('a.mp3')] }, parser, selectCover);
  assert.equal(root.title, 'Music');
  assert.equal(root.artist, 'Unknown Artist');
  const a = await readAlbum({ path: 'Games/Music/A/Same', tracks: [track('a.mp3')] }, parser, selectCover);
  const b = await readAlbum({ path: 'Games/Music/B/Same', tracks: [track('a.mp3')] }, parser, selectCover);
  assert.equal(a.title, b.title);
  assert.notEqual(a.path, b.path);
  assert.equal(a.artist, 'A');
});
test('album artist and local cover take precedence over track artist and embedded art', async () => {
  const parser = async () => ({ common: { album: 'Tagged Album', artist: 'Track Artist', albumartist: 'Album Artist',
    picture: [{ format: 'image/png', data: new Uint8Array(30), type: 'Cover (front)' }] } });
  const album = await readAlbum({ path: 'Games/Music/Folder', tracks: [track('a.mp3')], cover: { name: 'COVER.PNG', file: async () => new Blob() } }, parser, selectCover);
  assert.equal(album.title, 'Tagged Album');
  assert.equal(album.artist, 'Album Artist');
  assert.equal(album.artwork.kind, 'local');
  assert.equal(coverMime(album), 'image/png');
  assert.equal(albumCoverPath(album), 'Games/Music/Folder/COVER.PNG');
  // Preserve the decoded local format even when a file extension is misleading.
  album.cover.name = 'cover.jpg';
  album.original = { blob: new Blob([], { type: 'image/png' }) };
  assert.equal(coverMime(album), 'image/png');
});
test('parser reads original MP3/FLAC tags and embedded artwork', async () => {
  for (const name of ['tagged.mp3', 'tagged.flac', 'embedded.mp3']) {
    const bytes = await readFile(new URL(`../tests/fixtures/music/${name}`, import.meta.url));
    const album = await readAlbum({ path: 'Games/Music/Test', tracks: [{ name, file: async () => new File([bytes], name) }] }, parseBlob, selectCover);
    assert.notEqual(album.title, 'Test', name);
    if (name === 'embedded.mp3') assert.equal(album.artwork.kind, 'embedded');
  }
});
test('cover changes support undo, redo and revert; unchanged art is not written', () => {
  const old = { bytes: new Uint8Array([1]) }, next = { bytes: new Uint8Array([2]) };
  const album = { original: old, selected: old, loading: false, history: { undo: [], redo: [] } };
  assert.equal(needsCoverWrite(album), false);
  editCover(album, next);
  assert.equal(needsCoverWrite(album), true);
  coverHistory(album, 'undo');
  assert.equal(needsCoverWrite(album), false);
  coverHistory(album, 'redo');
  assert.equal(album.selected, next);
  coverHistory(album, 'revert');
  assert.equal(album.selected, old);
  coverHistory(album, 'undo');
  assert.equal(album.selected, next);
});
test('image dimensions are inspected before decode; other formats are rejected', () => {
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,0,0,0,0,128]);
  assert.deepEqual(imageSize(png), { width: 256, height: 128, mime: 'image/png' });
  assert.throws(() => imageSize(new Uint8Array([71,73,70])), /JPEG or PNG/);
});
test('album-only search correctly encodes title characters', async (t) => {
  let url;
  t.mock.method(globalThis, 'fetch', async (value) => { url = new URL(value); return Response.json({ candidates: [] }); });
  assert.deepEqual(await searchAlbums('https://studio.slot-cfw.fyi/api/music/', 'Unknown Artist', 'A & B', new AbortController().signal), []);
  assert.equal(url.pathname, '/api/music/search');
  assert.equal(url.searchParams.get('album'), 'A & B');
  assert.equal(url.searchParams.get('artist'), '');
});
test('missing cover and service failure are different outcomes', async (t) => {
  const id = 'c31a5e2b-0bf8-32e0-8aeb-ef4ba9973932';
  assert.ok(coverUrl(id, 250).startsWith('https://coverartarchive.org/'));
  assert.throws(() => coverUrl('../escape', 250));
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await fetchCover(id, 250, new AbortController().signal), null);
  mock.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(fetchCover(id, 250, new AbortController().signal), /HTTP 503/);
});
