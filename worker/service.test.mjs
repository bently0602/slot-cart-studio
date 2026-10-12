import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { MusicSearch, normalizeCandidates, searchQuery, USER_AGENT } from './service.js';
const ID = 'c31a5e2b-0bf8-32e0-8aeb-ef4ba9973932';
const group = (id = ID, extra = {}) => ({ id, title: 'Album', score: '100', 'primary-type': 'Album',
  'first-release-date': '2001-01-01', 'artist-credit': [{ name: 'A', joinphrase: ' & ' }, { artist: { name: 'B' } }], ...extra });
function state() {
  const entries = new Map();
  let alarm = null;
  return { entries, blockConcurrencyWhile: async (fn) => fn(), storage: {
    get: async (key) => entries.get(key), put: async (key, value) => entries.set(key, value),
    getAlarm: async () => alarm, setAlarm: async (value) => { alarm = value; },
    list: async ({ prefix, limit, startAfter }) => new Map([...entries].filter(([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort().slice(0, limit)),
    delete: async (keys) => { for (const k of keys) entries.delete(k); },
  } };
}
const request = (album = 'Album') => new Request(`https://studio.slot-cfw.fyi/api/music/search?artist=A&album=${encodeURIComponent(album)}`);
test('queries escape Lucene metacharacters and support album-only search', () => {
  assert.equal(searchQuery('', 'A "quoted" (live)'), 'releasegroup:"A \\"quoted\\" \\(live\\)"');
  assert.equal(searchQuery('A & B', 'Title'), 'releasegroup:"Title" AND artist:"A \\& B"');
});
test('candidates normalize artist credits, remove duplicates and prefer albums on tied scores', () => {
  const single = group('c31a5e2b-0bf8-32e0-8aeb-ef4ba9973933', { 'primary-type': 'Single' });
  const got = normalizeCandidates({ 'release-groups': [single, group(), group(), group('bad')] });
  assert.equal(got.length, 2);
  assert.equal(got[0].id, ID);
  assert.equal(got[0].artist, 'A & B');
  assert.equal(got[0].year, '2001');
  assert.ok(got[0].sourceUrl.startsWith('https://musicbrainz.org/'));
});
test('shared searches are paced, identified and cached for 24 hours', async (t) => {
  const started = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    started.push(Date.now());
    assert.equal(options.headers['User-Agent'], USER_AGENT);
    assert.equal(new URL(url).searchParams.get('limit'), '8');
    return Response.json({ 'release-groups': [group()] });
  });
  const storage = state();
  const service = new MusicSearch(storage);
  const [a, duplicate, b] = await Promise.all([service.fetch(request()), service.fetch(request()), service.fetch(request('Other'))]);
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), await duplicate.json());
  assert.equal(b.status, 200);
  assert.equal(started.length, 2);
  assert.ok(started[1] - started[0] >= 1000);
  const cached = [...storage.entries].find(([key]) => key.startsWith('search:'))[1];
  assert.ok(cached.expires - Date.now() > 86000000);
  await service.fetch(request());
  assert.equal(started.length, 2);
});
test('queue bounds return Retry-After, failures are not cached, expired results are removed', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { await gate; return new Response(null, { status: 503 }); });
  const storage = state();
  const service = new MusicSearch(storage);
  const queued = Array.from({ length: 8 }, (_, i) => service.fetch(request(`Album ${i}`)));
  await new Promise(setImmediate);
  const refused = await service.fetch(request('Overflow'));
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('Retry-After'), '3');
  // Failed requests still consume pacing slots.
  release();
  const results = await Promise.all(queued);
  assert.ok(results.every((r) => r.status === 503));
  assert.equal([...storage.entries.keys()].filter((k) => k.startsWith('search:')).length, 0);
  storage.entries.set('search:expired', { expires: 0 });
  await service.alarm();
  assert.equal(storage.entries.has('search:expired'), false);
});
test('public endpoint permits browser clients and rejects unknown routes and methods', async () => {
  const env = { MUSIC_SEARCH: { idFromName: () => 'singleton', get: () => ({ fetch: async () => Response.json({ candidates: [] }) }) } };
  const response = await worker.fetch(request(), env);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await worker.fetch(new Request('https://test/api/music/search', { method: 'POST' }), env)).status, 405);
  assert.equal((await worker.fetch(new Request('https://test/unrelated'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://test/api/music/search', { method: 'OPTIONS' }), env)).status, 204);
});
