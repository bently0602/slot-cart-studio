import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { crc32 } from 'node:zlib';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGO0snJiYGAAAAOUALgNWObMAAAAAElFTkSuQmCC', 'base64');
const bare = Buffer.alloc(32768, 1);
const rom = Buffer.concat([Buffer.alloc(512), bare]);
const crc = crc32(bare).toString(16).toUpperCase().padStart(8, '0');
const ID = 'c31a5e2b-0bf8-32e0-8aeb-ef4ba9973932';
let server, browser, base;
before(async () => {
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    try {
      if (path === '/art/index.json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ [crc]: { wheel: `SNES/wheel/${crc}.png`, 'support-texture': `SNES/support-texture/${crc}.png` } }));
      }
      if (path.startsWith('/art/')) { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
      if (path === '/rom.smc') return res.end(rom);
      if (path === '/corrupt.mp3') return res.end('corrupt');
      if (path === '/cover.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
      const file = path.startsWith('/fixtures/') ? resolve('tests/fixtures/music', path.slice(10)) : resolve('web', path === '/' ? 'index.html' : `.${path}`);
      if (!file.startsWith(resolve('web')) && !file.startsWith(resolve('tests/fixtures/music'))) throw new Error('invalid path');
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' })[extname(file)] ?? 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.STUDIO_CHROME ? { executablePath: process.env.STUDIO_CHROME } :
    process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) });
  await mkdir('out/browser', { recursive: true });
});
after(async () => { await browser?.close(); await new Promise((r) => server?.close(r)); });

async function studio(t, { search, covers } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('https://raw.githubusercontent.com/**', (route) => route.fulfill(route.request().url().includes('/metadat/') ? {
    contentType: 'text/plain', body: `game (\n name "SNES Probe (USA)"\n rom ( name "Probe.sfc" crc ${crc} )\n)\n`,
  } : { contentType: 'image/png', body: PNG }));
  await page.route('**/api/music/search?**', search ?? ((route) => route.fulfill({ json: { candidates: [{ id: ID, title: 'Suggested', artist: 'Artist', year: '2001', type: 'Album', sourceUrl: `https://musicbrainz.org/release-group/${ID}` }] } })));
  await page.route('https://coverartarchive.org/**', covers ?? ((route) => route.fulfill({ contentType: 'image/png', body: PNG })));
  await page.goto(`${base}/?art=${encodeURIComponent(`${base}/art/`)}&musicApi=${encodeURIComponent(`${base}/api/music/`)}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  return page;
}

async function openCard(page, files, direct = false, wait = true) {
  await page.evaluate(async ({ files, direct }) => {
    const list = [];
    for (const [path, url] of files) {
      const file = new File([await (await fetch(url)).blob()], path.split('/').at(-1));
      Object.defineProperty(file, 'webkitRelativePath', { value: `card/${path}` });
      list.push(file);
    }
    if (!direct) { await window.__studio.openFiles(list); return; }
    const root = { directories: {}, files: {} };
    for (const file of list) {
      const parts = file.webkitRelativePath.split('/').slice(1);
      let dir = root;
      for (const part of parts.slice(0, -1)) dir = dir.directories[part] ??= { directories: {}, files: {} };
      dir.files[parts.at(-1)] = file;
    }
    window.__written = [];
    const missing = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
    const handle = (dir, path = '') => ({
      kind: 'directory',
      async getDirectoryHandle(name, options = {}) {
        if (!dir.directories[name]) { if (!options.create) throw missing(); dir.directories[name] = { directories: {}, files: {} }; }
        return handle(dir.directories[name], path ? `${path}/${name}` : name);
      },
      async getFileHandle(name, options = {}) {
        if (!dir.files[name]) { if (!options.create) throw missing(); dir.files[name] = new File([], name); }
        return { kind: 'file', getFile: async () => dir.files[name], createWritable: async () => {
          let staged;
          return { write: async (bytes) => { staged = bytes; }, close: async () => {
            dir.files[name] = new File([staged], name);
            window.__written.push({ path: `${path}/${name}`, bytes: [...new Uint8Array(await dir.files[name].arrayBuffer())] });
          }, abort: async () => {} };
        } };
      },
      async removeEntry(name) { delete dir.files[name]; },
      async *entries() {
        for (const name of Object.keys(dir.directories)) yield [name, await this.getDirectoryHandle(name)];
        for (const name of Object.keys(dir.files)) yield [name, await this.getFileHandle(name)];
      },
    });
    await window.__studio.openDirectory(handle(root));
  }, { files, direct });
  if (!wait) return;
  await page.waitForFunction(() => window.__studio.idle());
  if (await page.locator('#fill').isVisible()) await page.locator('#fill-real').click();
  await page.waitForFunction(() => window.__studio.idle());
}

test('mixed card matches headered SNES, renders its cartridge and saves selected music in a ZIP', async (t) => {
  const page = await studio(t);
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Games/Music/Artist/Album/one.mp3', `${base}/corrupt.mp3`]]);
  const games = await page.evaluate(() => window.__studio.states());
  assert.equal(games[0].game, 'SNES Probe (USA)');
  assert.equal(games[0].platform, 'SNES');
  assert.deepEqual(await page.locator('.cart:not(.album) canvas').evaluate((c) => [c.width, c.height]), [360, 225]);
  await page.locator('.cart:not(.album)').click();
  assert.equal(await page.locator('#ed-finish').isVisible(), false);
  assert.equal(await page.locator('#ed-outline-row').isVisible(), false);
  await page.getByRole('button', { name: 'Music', exact: false }).filter({ has: page.locator('.n') }).click();
  await page.locator('.album').click();
  await page.locator('.music-hit:not(:disabled)').first().click();
  await page.waitForFunction(() => window.__studio.albums()[0].ready);
  await page.locator('#music-undo').click();
  assert.equal((await page.evaluate(() => window.__studio.albums()))[0].ready, false);
  await page.locator('#music-redo').click();
  const download = page.waitForEvent('download');
  await page.locator('#write').click();
  const file = await download;
  await file.saveAs('out/browser/mixed.zip');
  const zip = await readFile('out/browser/mixed.zip');
  assert.ok(zip.includes(Buffer.from('Labels/SNES/Probe.png')));
  assert.ok(zip.includes(Buffer.from('Games/Music/Artist/Album/cover.jpg')));
  for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50;) {
    const size = zip.readUInt32LE(offset + 18);
    const length = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + length + zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + length).toString();
    if (name === 'Labels/SNES/Probe.png') assert.deepEqual([zip.readUInt32BE(start + 16), zip.readUInt32BE(start + 20)], [960, 584]);
    if (name.endsWith('/cover.jpg')) assert.deepEqual([...zip.subarray(start, start + 2)], [255, 216]);
    offset = start + size;
  }
  await page.screenshot({ path: 'out/browser/music-picker.png', fullPage: true });
});

test('music-only cards keep local and embedded covers; direct replacement preserves PNG filename', async (t) => {
  let searches = 0;
  const page = await studio(t, { search: (route) => { searches++; return route.fulfill({ json: { candidates: [] } }); } });
  await openCard(page, [['Games/Music/Local/one.mp3', `${base}/fixtures/tagged.mp3`], ['Games/Music/Local/COVER.PNG', `${base}/cover.png`],
    ['Games/Music/Embedded/one.mp3', `${base}/fixtures/embedded.mp3`]], true);
  const albums = await page.evaluate(() => window.__studio.albums());
  assert.deepEqual(albums.map((a) => a.artwork), ['embedded', 'local']);
  assert.ok(albums.every((a) => a.selected && !a.ready));
  await page.locator('.album').last().click();
  assert.equal(searches, 0);
  await page.locator('#music-file').setInputFiles({ name: 'replacement.jpg', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => window.__studio.albums().some((a) => a.ready));
  await page.locator('#write').click();
  await page.waitForFunction(() => window.__written.length === 1);
  const written = await page.evaluate(() => window.__written[0]);
  assert.equal(written.path, 'Games/Music/Local/COVER.PNG');
  assert.deepEqual(written.bytes.slice(0, 8), [...PNG.slice(0, 8)]);
  assert.ok((await page.evaluate(() => window.__studio.albums())).every((a) => !a.ready));
});

test('old search results cannot change another album and provider failures allow manual import', async (t) => {
  let resolveSearch;
  const gate = new Promise((resolve) => { resolveSearch = resolve; });
  let count = 0;
  const page = await studio(t, { search: async (route) => {
    if (++count === 1) { await gate; await route.fulfill({ json: { candidates: [{ id: ID, title: 'Late result', artist: 'A' }] } }).catch(() => {}); }
    else await route.fulfill({ status: 502, json: { error: 'unavailable' } });
  } });
  await openCard(page, [['Games/Music/A/First/one.mp3', `${base}/corrupt.mp3`], ['Games/Music/B/Second/one.mp3', `${base}/corrupt.mp3`]]);
  await page.locator('.album').first().click();
  await page.waitForTimeout(100);
  await page.locator('#music-close').click();
  await page.locator('.album').last().click();
  resolveSearch();
  await page.locator('#music-message').getByText(/unavailable/).waitFor();
  assert.equal(await page.locator('#music-hits').innerText(), '');
  assert.ok((await page.evaluate(() => window.__studio.albums())).every((a) => !a.ready));
  await page.locator('#music-file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => window.__studio.albums()[1].ready);
  assert.equal((await page.evaluate(() => window.__studio.albums()))[0].ready, false);
});

test('cover export preserves proportions while preview is square; invalid imports leave state alone', async (t) => {
  const page = await studio(t);
  await openCard(page, [['Games/Music/Album/one.mp3', `${base}/corrupt.mp3`]]);
  const size = await page.evaluate(async () => {
    const { prepareCover } = await import('./music.js');
    const canvas = document.createElement('canvas');
    canvas.width = 2000; canvas.height = 1000;
    const blob = await new Promise((r) => canvas.toBlob(r));
    const cover = await prepareCover(blob);
    const image = await createImageBitmap(cover.blob);
    const dims = [image.width, image.height]; image.close(); return dims;
  });
  assert.deepEqual(size, [1200, 600]);
  await page.locator('.album').click();
  await page.locator('#music-file').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await page.locator('#music-message').getByText(/JPEG or PNG/).waitFor();
  assert.equal((await page.evaluate(() => window.__studio.albums()))[0].ready, false);
  await page.setViewportSize({ width: 400, height: 800 });
  const jpeg = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 2;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.locator('#music-file').setInputFiles({ name: 'cover.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg) });
  await page.waitForFunction(() => window.__studio.albums()[0].ready);
  assert.equal(await page.locator('#music-face').evaluate((image) => getComputedStyle(image).objectFit), 'cover');
  const download = page.waitForEvent('download');
  await page.locator('#music-save').click();
  await download;
  await page.screenshot({ path: 'out/browser/mobile.png', fullPage: true });
});

test('game matching outages do not prevent music lookup or selection', async (t) => {
  const page = await studio(t);
  await page.unroute('https://raw.githubusercontent.com/**');
  await page.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({ status: 503 }));
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Games/Music/Album/one.mp3', `${base}/corrupt.mp3`]]);
  await page.getByRole('button', { name: 'Music', exact: false }).filter({ has: page.locator('.n') }).click();
  await page.locator('.album').click();
  await page.locator('.music-hit:not(:disabled)').first().click();
  await page.waitForFunction(() => window.__studio.albums()[0].ready);
});

test('edited queries and replacement cards ignore obsolete searches and cover downloads', async (t) => {
  let releaseSearch, releaseCover, coverStarted;
  const searchGate = new Promise((resolve) => { releaseSearch = resolve; });
  const coverGate = new Promise((resolve) => { releaseCover = resolve; });
  const beganCover = new Promise((resolve) => { coverStarted = resolve; });
  let searches = 0;
  const page = await studio(t, {
    search: async (route) => {
      const title = ++searches === 1 ? 'Obsolete' : 'Current';
      if (searches === 1) await searchGate;
      await route.fulfill({ json: { candidates: [{ id: ID, title, artist: 'Artist' }] } }).catch(() => {});
    },
    covers: async (route) => {
      if (route.request().url().endsWith('1200')) { coverStarted(); await coverGate; }
      await route.fulfill({ contentType: 'image/png', body: PNG }).catch(() => {});
    },
  });
  t.after(() => { releaseSearch(); releaseCover(); });
  await openCard(page, [['Games/Music/Old/one.mp3', `${base}/corrupt.mp3`]]);
  await page.locator('.album').click();
  await page.waitForFunction(() => document.querySelector('#music-message').textContent.includes('Looking'));
  await page.locator('#music-album').fill('Edited title');
  await page.locator('#music-search').click();
  releaseSearch();
  await page.locator('.music-hit:not(:disabled)').filter({ hasText: 'Current' }).click();
  await beganCover;
  await openCard(page, [['Games/Music/New/one.mp3', `${base}/corrupt.mp3`]]);
  releaseCover();
  await page.waitForTimeout(100);
  const albums = await page.evaluate(() => window.__studio.albums());
  assert.equal(albums.length, 1);
  assert.equal(albums[0].path, 'Games/Music/New');
  assert.equal(albums[0].ready, false);
  assert.equal(albums[0].selected, false);
});

test('opening an album during scanning fills search fields when its tags arrive', async (t) => {
  const page = await studio(t);
  let release, began;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { began = resolve; });
  t.after(() => release());
  await page.route(`${base}/vendor/music-metadata.js`, async (route) => { began(); await gate; await route.continue(); });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Games/Music/Folder/one.mp3', `${base}/fixtures/tagged.mp3`]], false, false);
  await started;
  await page.locator('#fill-real').click();
  await page.getByRole('button', { name: 'Music', exact: false }).filter({ has: page.locator('.n') }).click();
  await page.locator('.album').click();
  assert.equal(await page.locator('#music-album').inputValue(), 'Folder');
  release();
  await page.waitForFunction(() => window.__studio.idle());
  const [album] = await page.evaluate(() => window.__studio.albums());
  assert.notEqual(album.title, 'Folder');
  assert.equal(await page.locator('#music-album').inputValue(), album.title);
  assert.equal(await page.locator('#music-artist').inputValue(), album.artist);
});
