import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchArt, fetchDat, fetchLibrary, fetchThumb } from './libretro.js';

const base = 'http://127.0.0.1:8765/art/';
const bytes = new Uint8Array([137, 80, 78, 71]);

test('all five platforms read their cached databases and covers, with no remote fallback', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  const library = { base, platforms: {} };
  globalThis.fetch = async url => {
    url = String(url); requests.push(url);
    assert.ok(url.startsWith(base), url);
    return url.endsWith('.dat') ? new Response('cached database') : new Response(bytes);
  };
  for (const platform of ['GBA', 'GB', 'GBC', 'SNES', 'PSX']) {
    library.platforms[platform] = { database: `dat/${platform}.dat`, thumbnails: {
      Named_Boxarts: { 'Game (USA)': `${platform}/boxart/file.png` }, Named_Logos: {},
    } };
    assert.equal(await fetchDat(platform, library), 'cached database');
    assert.deepEqual(await fetchThumb(platform, 'Named_Boxarts', 'Game (USA)', null, library), bytes);
    const count = requests.length;
    assert.equal(await fetchThumb(platform, 'Named_Boxarts', 'Missing', null, library), null);
    assert.equal(await fetchThumb(platform, 'Named_Logos', 'Game (USA)', null, library), null);
    assert.equal(requests.length, count);
  }
});

test('offline artwork rejects external and escaping paths before sending a request', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = () => { throw new Error('must not request'); };
  for (const path of ['https://art.slot-cfw.fyi/image.png', '../private.png', '/private.png']) {
    await assert.rejects(fetchArt(base, path, true), /nonlocal/);
  }
  await assert.rejects(fetchDat('PSX', { base, platforms: {} }), /no PSX database/);
});

test('older artwork sets remain compatible, while valid cached sets enable local mode', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('', { status: 404 });
  assert.equal(await fetchLibrary(base), null);
  globalThis.fetch = async () => Response.json({ version: 1, offline: true, platforms: {} });
  assert.equal((await fetchLibrary(base)).base, base);
  globalThis.fetch = async () => Response.json({ version: 2, platforms: {} });
  await assert.rejects(fetchLibrary(base), /Unsupported/);
});

test('automatic artwork libraries request missing named images through localhost', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  globalThis.fetch = async url => { requests.push(String(url)); return new Response(bytes); };
  const library = { base, onDemand: true, platforms: { GBA: { thumbnails: {} } } };
  assert.deepEqual(await fetchThumb('GBA', 'Named_Boxarts', 'Game (USA) + Extra', null, library), bytes);
  assert.deepEqual(requests, [`${base}thumbnails/GBA/Named_Boxarts/Game%20(USA)%20%2B%20Extra.png`]);
  assert.equal(await fetchThumb('GB', 'Named_Boxarts', 'Missing', null, library), null);
  assert.equal(await fetchThumb('GBA', '../private', 'Missing', null, library), null);
  assert.equal(requests.length, 1);
});
