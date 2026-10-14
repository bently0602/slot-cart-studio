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
const rawCrc = crc32(rom).toString(16).toUpperCase().padStart(8, '0');
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
      if (path === '/art/library.json') return res.writeHead(404).end('not found');
      if (path.startsWith('/art/')) { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
      if (path === '/rom.smc') return res.end(rom);
      if (path === '/corrupt.mp3') return res.end('corrupt');
      if (path === '/cover.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
      const file = path.startsWith('/fixtures/') ? resolve('tests/fixtures/music', path.slice(10)) : resolve('web', path === '/' ? 'index.html' : `.${path}`);
      if (!file.startsWith(resolve('web')) && !file.startsWith(resolve('tests/fixtures/music'))) throw new Error('invalid path');
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
        '.wasm': 'application/wasm', '.gif': 'image/gif', '.png': 'image/png', '.txt': 'text/plain' })[extname(file)] ?? 'application/octet-stream');
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

async function studio(t, { search, covers, fallback = false, artIndex, dat, library } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  t.after(() => context.close());
  const page = await context.newPage();
  if (fallback) await page.addInitScript(() => { delete window.showDirectoryPicker; });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  if (artIndex !== undefined) await page.route(`${base}/art/index.json`, route => route.fulfill({ json: artIndex }));
  if (library) {
    await page.route(`${base}/art/library.json`, route => route.fulfill({ json: library }));
    await page.route(`${base}/art/dat/*.dat`, route => route.fulfill({ contentType: 'text/plain',
      body: dat ?? `game (\n name "SNES Probe (USA)"\n rom ( crc ${crc} )\n)\n` }));
  }
  await page.route('https://raw.githubusercontent.com/**', (route) => route.fulfill(route.request().url().includes('/metadat/') ? {
    contentType: 'text/plain', body: dat ?? `game (\n name "SNES Probe (USA)"\n rom ( name "Probe.sfc" crc ${crc} )\n)\n`,
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
        if (window.__rejectLegacyShell && name === 'cart_shell.ini') throw new TypeError('Name is not allowed.');
        if (!dir.files[name]) { if (!options.create) throw missing(); dir.files[name] = new File([], name); }
        return { kind: 'file', getFile: async () => {
          if (window.__rejectShellRead && name === 'cart_shell.txt') throw Object.assign(new Error('Card read failed'), { name: 'NotReadableError' });
          return dir.files[name];
        }, createWritable: async () => {
          let staged;
          return { write: async (bytes) => { if (window.__writeGate) await window.__writeGate; staged = bytes; }, close: async () => {
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

test('blocked optional legacy shell lookup does not display a firmware notice', async (t) => {
  const page = await studio(t);
  await page.evaluate(() => { window.__rejectLegacyShell = true; });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`],
    ['Config/readme.txt', `${base}/corrupt.mp3`], ['Labels/readme.txt', `${base}/corrupt.mp3`]], true);
  assert.equal(await page.locator('#banner').isVisible(), false);
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].game, 'SNES Probe (USA)');
  await page.evaluate(() => { window.__rejectShellRead = true; });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Config/cart_shell.txt', `${base}/corrupt.mp3`]], true);
  assert.equal(await page.locator('#banner').isVisible(), true);
  assert.match(await page.locator('#banner-message').innerText(), /shells couldn’t be read/);
});

test('Horizon controls support keyboard navigation and card replacement on mobile', async (t) => {
  const page = await studio(t);
  const frameworkUrls = await page.evaluate(() => performance.getEntriesByType('resource')
    .map(({ name }) => name).filter((name) => name.includes('/vendor/horizonjs/')));
  assert.ok(frameworkUrls.some((url) => url.endsWith('/adapter/ext/ext-base.js')));
  assert.ok(frameworkUrls.some((url) => url.endsWith('/ext-all.js')));
  assert.ok(frameworkUrls.every((url) => new URL(url).origin === new URL(base).origin));
  await page.setViewportSize({ width: 400, height: 800 });
  const mixed = [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Games/Music/Album/one.mp3', `${base}/corrupt.mp3`]];
  await openCard(page, mixed);
  const musicTab = page.locator('#tabs [role="tab"]:visible').filter({ hasText: 'Music' });
  await musicTab.focus();
  await page.keyboard.press('Enter');
  assert.equal(await musicTab.getAttribute('aria-selected'), 'true');
  await page.locator('.album').click();
  assert.equal(await page.locator('#music-editor').isVisible(), true);
  await page.locator('#music-close').click();
  assert.equal(await page.locator('#music-editor').isVisible(), false);
  await musicTab.hover();
  await openCard(page, mixed.slice(0, 1));
  await page.mouse.move(1, 1);
  assert.equal(await page.getByRole('tab').count(), 1);
  await openCard(page, mixed);
  assert.equal(await page.locator('#tabs [role="tab"]:visible').count(), 2);
  assert.equal(await page.title(), 'Cart Studio');
  assert.equal(await page.locator('body').innerText().then(text => /slot\./i.test(text)), false);
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
});

test('mixed card matches headered SNES, previews artwork without a shell and saves selected music in a ZIP', async (t) => {
  const page = await studio(t);
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Games/Music/Artist/Album/one.mp3', `${base}/corrupt.mp3`]]);
  const games = await page.evaluate(() => window.__studio.states());
  assert.equal(games[0].game, 'SNES Probe (USA)');
  assert.equal(games[0].platform, 'SNES');
  assert.deepEqual(await page.locator('.cart:not(.album) canvas').evaluate((c) => [c.width, c.height]), [240, 146]);
  const corners = await page.locator('.cart:not(.album) canvas').evaluate(c => {
    const context = c.getContext('2d');
    return [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1]]
      .map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
  });
  const expected = await page.evaluate(async url => {
    const image = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return [0, image.width - 1].map(x => [...context.getImageData(x, 0, 1, 1).data]);
  }, `${base}/cover.png`);
  assert.deepEqual(corners, [...expected, ...expected], 'artwork reaches every edge without shell pixels');
  await page.locator('.cart:not(.album)').click();
  assert.deepEqual(await page.locator('#ed-face').evaluate(c => [c.width, c.height]), [240, 146]);
  assert.equal(await page.locator('#ed-shell-custom').isVisible(), false);
  assert.equal(await page.locator('#ed-finish').isVisible(), false);
  assert.equal(await page.locator('#ed-outline-row').isVisible(), false);
  await page.locator('#ed-close').click();
  await page.getByRole('tab', { name: 'Music', exact: true }).click();
  await page.locator('.album').click();
  await page.locator('.music-hit:not(:disabled)').first().click();
  await page.waitForFunction(() => window.__studio.albums()[0].ready);
  await page.locator('#music-undo').click();
  assert.equal((await page.evaluate(() => window.__studio.albums()))[0].ready, false);
  await page.locator('#music-redo').click();
  const download = page.waitForEvent('download');
  await page.locator('#music-save').click();
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

test('handhelds use their own logo repositories and save correctly sized fallback labels', async t => {
  const page = await studio(t, { artIndex: {} });
  await page.route('**/metadat/**', route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const platform = path.includes('Game Boy Advance') ? 'GBA' : path.includes('Game Boy Color') ? 'GBC' : 'GB';
    return route.fulfill({ contentType: 'text/plain',
      body: `game (\n name "${platform} Probe (USA)"\n rom ( name "Probe" crc ${rawCrc} )\n)\n` });
  });
  const repositories = [];
  await page.route('**/Named_Logos/**', route => {
    repositories.push(new URL(route.request().url()).pathname.split('/')[2]);
    return route.fulfill({ contentType: 'image/png', body: PNG });
  });
  await openCard(page, [['Games/GBA/Original Name.gba', `${base}/rom.smc`],
    ['Games/GB/Original Name.gb', `${base}/rom.smc`], ['Games/GBC/Original Name.gbc', `${base}/rom.smc`]], true);
  assert.deepEqual(repositories.sort(), ['Nintendo_-_Game_Boy', 'Nintendo_-_Game_Boy_Advance', 'Nintendo_-_Game_Boy_Color']);
  const games = await page.evaluate(() => window.__studio.states());
  assert.equal(games.length, 3);
  assert.ok(games.every(game => game.state === 'ready' && game.wears === 'logo' && game.logo > 0));
  await page.locator('#write').click();
  await page.waitForFunction(() => window.__written.length === 3 && window.__studio.idle());
  const saved = await page.evaluate(() => window.__written);
  for (const [platform, width, height] of [['GBA', 1280, 661], ['GB', 1024, 901], ['GBC', 1024, 901]]) {
    const file = saved.find(file => file.path === `Labels/${platform}/Original Name.png`);
    assert.ok(file, platform);
    const png = Buffer.from(file.bytes);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, height]);
  }
});

test('handhelds keep preferred hosted logos and tolerate missing fallback images', async t => {
  for (const [platform, extension] of [['GBA', 'gba'], ['GB', 'gb'], ['GBC', 'gbc']]) {
    await t.test(platform, async t => {
      const page = await studio(t, { artIndex: { [rawCrc]: { wheel: `${platform}/wheel/${rawCrc}.png` } } });
      await page.route('**/metadat/**', route => route.fulfill({ contentType: 'text/plain',
        body: `game (\n name "${platform} Probe (USA)"\n rom ( name "Probe" crc ${rawCrc} )\n)\n` }));
      let logos = 0;
      await page.route('**/Named_Logos/**', route => { ++logos; return route.fulfill({ status: 404, body: '' }); });
      await openCard(page, [[`Games/${platform}/Probe.${extension}`, `${base}/rom.smc`]]);
      assert.equal(logos, 0);
      assert.ok((await page.evaluate(() => window.__studio.states()))[0].logo > 0);
      await page.route(`${base}/art/index.json`, route => route.fulfill({ json: {} }));
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.ready === 'true');
      await openCard(page, [[`Games/${platform}/Probe.${extension}`, `${base}/rom.smc`]]);
      assert.equal(logos, 1);
      assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
      await page.locator('.cart').click();
      assert.equal(await page.locator('#choose-customLogo').isEnabled(), true);
    });
  }
});

test('GBA and GB load real libretro logos when the hosted index is empty', {
  skip: !process.env.STUDIO_LIVE_HANDHELDS,
}, async t => {
  const page = await studio(t, { artIndex: {} });
  const names = { GBA: 'Pokemon - Emerald Version (USA, Europe)', GB: 'Pokemon - Red Version (USA, Europe) (SGB Enhanced)' };
  await page.route('**/metadat/**', route => {
    const platform = decodeURIComponent(route.request().url()).includes('Game Boy Advance') ? 'GBA' : 'GB';
    return route.fulfill({ contentType: 'text/plain',
      body: `game (\n name "${names[platform]}"\n rom ( name "Probe" crc ${rawCrc} )\n)\n` });
  });
  await page.route('**/Named_Logos/**', route => route.continue());
  await openCard(page, [['Games/GBA/Emerald.gba', `${base}/rom.smc`], ['Games/GB/Red.gb', `${base}/rom.smc`]]);
  const games = await page.evaluate(() => window.__studio.states());
  assert.equal(games.length, 2);
  assert.ok(games.every(game => game.wears === 'logo' && game.logo > 1000));
});

test('SNES loads a real libretro logo when the hosted index is empty', {
  skip: !process.env.STUDIO_LIVE_SNES,
}, async t => {
  const page = await studio(t, { artIndex: {} });
  await page.route('**/metadat/**', route => route.fulfill({ contentType: 'text/plain',
    body: `game (\n name "Super Mario World (USA)"\n rom ( name "Super Mario World.sfc" crc ${crc} )\n)\n` }));
  await page.route('**/Named_Logos/**', route => route.continue());
  await openCard(page, [['Games/SNES/Super Mario World.smc', `${base}/rom.smc`]]);
  const [game] = await page.evaluate(() => window.__studio.states());
  assert.equal(game.game, 'Super Mario World (USA)');
  assert.equal(game.wears, 'logo');
  assert.ok(game.logo > 1000);
  await page.screenshot({ path: 'out/browser/snes-fallback-live.png', fullPage: true });
});

test('SNES loads aliased libretro logos with an empty hosted index and saves the generated label', async (t) => {
  const page = await studio(t, { artIndex: {} });
  const requests = [];
  await page.route('**/Named_Logos/**', route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
    requests.push(name);
    return route.fulfill(name === 'SNES Probe (USA).png'
      ? { contentType: 'text/plain', body: 'Shared Logo (Europe).png' }
      : { contentType: 'image/png', body: PNG });
  });
  await openCard(page, [['Games/SNES/Original Name.smc', `${base}/rom.smc`]], true);
  assert.deepEqual(requests, ['SNES Probe (USA).png', 'Shared Logo (Europe).png']);
  const [game] = await page.evaluate(() => window.__studio.states());
  assert.equal(game.game, 'SNES Probe (USA)');
  assert.equal(game.state, 'ready');
  assert.equal(game.wears, 'logo');
  assert.ok(game.logo > 0);
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
  await page.locator('#write').click();
  await page.waitForFunction(() => window.__written.length === 1 && window.__studio.idle());
  const saved = await page.evaluate(() => window.__written[0]);
  assert.equal(saved.path, 'Labels/SNES/Original Name.png');
  const label = Buffer.from(saved.bytes);
  assert.deepEqual([label.readUInt32BE(16), label.readUInt32BE(20)], [960, 584]);
});

test('SNES falls back when its hosted logo is missing, invalid, or fails to download', async t => {
  for (const failure of ['missing', 'invalid', 'unavailable']) {
    await t.test(failure, async t => {
      const page = await studio(t);
      await page.route(`${base}/art/SNES/wheel/**`, route => failure === 'unavailable' ? route.abort()
        : route.fulfill(failure === 'missing' ? { status: 404, body: '' } : { body: 'not a PNG' }));
      let logos = 0;
      await page.route('**/Named_Logos/**', route => { ++logos; return route.fulfill({ contentType: 'image/png', body: PNG }); });
      await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`]]);
      assert.equal(logos, 1);
      assert.ok((await page.evaluate(() => window.__studio.states()))[0].logo > 0);
      await page.locator('.cart').click();
      await page.locator('#choose-logo').click();
      assert.equal((await page.evaluate(() => window.__studio.states()))[0].wears, 'logo');
    });
  }
});

test('SNES prefers hosted logos and handles missing fallback artwork without blocking imports', async t => {
  const page = await studio(t);
  let logos = 0;
  await page.route('**/Named_Logos/**', route => { ++logos; return route.fulfill({ status: 404, body: '' }); });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`]]);
  assert.equal(logos, 0);
  await page.route(`${base}/art/index.json`, route => route.fulfill({ json: {} }));
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`]]);
  assert.equal(logos, 1);
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].logo, 0);
  await page.locator('.cart').click();
  assert.equal(await page.locator('#choose-customLogo').isEnabled(), true);
});

test('Real Label keeps the previous preview while loading and respects a newer selection', async t => {
  const page = await studio(t);
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  t.after(() => release());
  await page.route(`${base}/art/SNES/support-texture/**`, async route => {
    began(); await gate;
    await route.fulfill({ contentType: 'image/png', body: PNG }).catch(() => {});
  });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Labels/SNES/Probe.png', `${base}/cover.png`]]);
  await page.locator('.cart').click();
  await started;
  await page.waitForFunction(() => !document.getElementById('choose-real').disabled);
  const preview = await page.locator('#ed-face').evaluate(canvas => canvas.toDataURL());
  const gameRow = await page.locator('#ed-game').boundingBox();
  await page.locator('#choose-real').click();
  assert.equal(await page.locator('#ed-face').isVisible(), true);
  assert.equal(await page.locator('#ed-face').evaluate(canvas => canvas.toDataURL()), preview);
  assert.match(await page.locator('#ed-preview-message').innerText(), /Loading real label/);
  assert.equal(await page.locator('#ed-preview').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#ed-real-loading').isVisible(), true);
  assert.equal(await page.getByRole('progressbar', { name: 'Loading real label', exact: true }).isVisible(), true);
  assert.equal(await page.locator('#choose-real').getAttribute('aria-pressed'), 'true');
  assert.equal((await page.locator('#ed-game').boundingBox()).y, gameRow.y);
  await page.locator('#choose-logo').click();
  assert.equal(await page.locator('#ed-real-loading').isVisible(), false);
  release();
  await page.waitForFunction(() => window.__studio.idle());
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].wears, 'logo');
  assert.equal(await page.locator('#choose-logo').getAttribute('aria-pressed'), 'true');
  await page.locator('#choose-real').click();
  assert.equal(await page.locator('#ed-preview').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#ed-real-loading').isVisible(), false);
  assert.match(await page.locator('#ed-preview-message').innerText(), /Selected: Real Label/);
  await page.locator('#ed-undo').click();
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].wears, 'logo');
  await page.locator('#ed-redo').click();
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].wears, 'real');
});

test('Real Label reports failure and refreshes loading feedback when retrying the same choice', async t => {
  const page = await studio(t);
  let release, began;
  let fail = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  t.after(() => release());
  await page.route(`${base}/art/SNES/support-texture/**`, async route => {
    if (fail) return route.fulfill({ status: 503, body: 'unavailable' });
    began(); await gate;
    await route.fulfill({ contentType: 'image/png', body: PNG }).catch(() => {});
  });
  fail = true;
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Labels/SNES/Probe.png', `${base}/cover.png`]]);
  await page.locator('.cart').click();
  await page.waitForFunction(() => document.getElementById('choose-real').textContent.includes('Retry'));
  await page.locator('#choose-real').click();
  await page.waitForFunction(() => window.__studio.idle());
  assert.match(await page.locator('#ed-preview-message').innerText(), /couldn’t load.*Showing Logo Only/);
  assert.equal(await page.locator('#ed-real-loading').isVisible(), false);
  assert.equal(await page.locator('#ed-face').isVisible(), true);
  fail = false;
  await page.locator('#choose-real').click();
  await started;
  assert.match(await page.locator('#ed-preview-message').innerText(), /Loading real label/);
  assert.equal(await page.locator('#ed-preview').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#choose-real').isDisabled(), true);
  assert.equal(await page.locator('#ed-real-loading').isVisible(), true);
  release();
  await page.waitForFunction(() => window.__studio.idle());
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].wears, 'real');
  assert.equal(await page.locator('#ed-preview').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#ed-real-loading').isVisible(), false);
  await page.locator('#choice-logo').click();
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].wears, 'logo');
  await page.setViewportSize({ width: 400, height: 650 });
  await page.locator('#choose-real').click();
  const frame = await page.locator('#ed-preview').boundingBox();
  assert.ok(frame.y >= 0 && frame.y + frame.height <= 650, 'main preview stays visible while choosing images on mobile');
  await page.screenshot({ path: 'out/browser/real-label-mobile.png' });
});

test('delayed SNES fallback logos keep loading masked and cannot change a replacement card', async t => {
  const page = await studio(t, { artIndex: {} });
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  t.after(() => release());
  await page.route('**/Named_Logos/**', async route => {
    began(); await gate; await route.fulfill({ contentType: 'image/png', body: PNG }).catch(() => {});
  });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`]], false, false);
  await started;
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), true);
  await openCard(page, [['Games/Music/New/one.mp3', `${base}/corrupt.mp3`]], false, false);
  release();
  await page.waitForFunction(() => window.__studio.idle());
  assert.deepEqual(await page.evaluate(() => window.__studio.states()), []);
  assert.equal((await page.evaluate(() => window.__studio.albums()))[0].path, 'Games/Music/New');
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
});

test('SNES imported labels write to the card and reopen with the original ROM stem', async (t) => {
  const page = await studio(t);
  await openCard(page, [['Games/SNES/Original Name.smc', `${base}/rom.smc`]], true);
  await page.locator('.cart').click();
  const picker = page.waitForEvent('filechooser');
  await page.locator('#choose-customLabel').click();
  await (await picker).setFiles({ name: 'label.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => window.__studio.states()[0].wears === 'customLabel');
  await page.locator('#ed-close').click();
  await page.locator('#write').click();
  await page.waitForFunction(() => window.__written.length === 1 && window.__studio.idle());
  const written = await page.evaluate(() => window.__written[0]);
  assert.equal(written.path, 'Labels/SNES/Original Name.png');
  const label = Buffer.from(written.bytes);
  assert.deepEqual([label.readUInt32BE(16), label.readUInt32BE(20)], [960, 584]);
  await page.evaluate(async romUrl => {
    const saved = window.__written[0];
    const rom = new File([await (await fetch(romUrl)).blob()], 'Original Name.smc');
    const png = new File([new Uint8Array(saved.bytes)], 'Original Name.png');
    Object.defineProperty(rom, 'webkitRelativePath', { value: 'card/Games/SNES/Original Name.smc' });
    Object.defineProperty(png, 'webkitRelativePath', { value: `card/${saved.path}` });
    await window.__studio.openFiles([rom, png]);
  }, `${base}/rom.smc`);
  await page.waitForFunction(() => window.__studio.idle());
  const [game] = await page.evaluate(() => window.__studio.states());
  assert.equal(game.state, 'has-label');
  assert.equal(game.wears, 'card');
  assert.deepEqual(await page.locator('.cart canvas').evaluate(c => [c.width, c.height]), [240, 146]);
});

test('a cached game library loads and saves SNES labels while all game-artwork services are blocked', async (t) => {
  const page = await studio(t, { library: { version: 1, offline: true, platforms: {
    SNES: { database: 'dat/SNES.dat', thumbnails: {
      Named_Boxarts: { 'SNES Probe (USA)': `SNES/boxart/${crc}.png` }, Named_Logos: {},
    } },
  } } });
  const remote = [];
  await page.route('https://raw.githubusercontent.com/**', route => { remote.push(route.request().url()); return route.abort(); });
  await page.route('https://art.slot-cfw.fyi/**', route => { remote.push(route.request().url()); return route.abort(); });
  await openCard(page, [['Games/SNES/Offline.smc', `${base}/rom.smc`]], true);
  const [game] = await page.evaluate(() => window.__studio.states());
  assert.equal(game.game, 'SNES Probe (USA)');
  assert.equal(game.wears, 'real');
  await page.locator('.cart').click();
  await page.locator('#ed-close').click();
  await page.locator('#write').click();
  await page.waitForFunction(() => window.__written.length === 1 && window.__studio.idle());
  assert.equal((await page.evaluate(() => window.__written[0])).path, 'Labels/SNES/Offline.png');
  assert.deepEqual(remote, []);
});

test('Near trial uses the actual Chrono Trigger label and saves/reopens it',
  { skip: !process.env.STUDIO_NEAR_ART }, async (t) => {
    const root = resolve(process.env.STUDIO_NEAR_ART);
    const index = JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8'));
    const entry = index['2D206BF7'];
    assert.equal(entry['support-texture'], 'SNES/support-texture/chrono-trigger.png');
    const label = await readFile(resolve(root, entry['support-texture']));
    assert.deepEqual([label.readUInt32BE(16), label.readUInt32BE(20)], [960, 584]);
    assert.ok(label.length > 100_000, 'must use the downloaded scan, not a fixture thumbnail');
    // Use a synthetic ROM and database match; no copyrighted ROM is downloaded.
    const page = await studio(t, { artIndex: { [crc]: entry },
      dat: `game (\n name "Chrono Trigger (USA)"\n rom ( crc ${crc} )\n)\n` });
    await page.route(`${base}/art/${entry['support-texture']}`,
      route => route.fulfill({ contentType: 'image/png', body: label }));
    await openCard(page, [['Games/SNES/Chrono Trigger.smc', `${base}/rom.smc`]], true);
    assert.equal((await page.evaluate(() => window.__studio.states()))[0].wears, 'real');
    await page.locator('.cart').click();
    await page.screenshot({ path: 'out/browser/near-chrono-editor.png' });
    await page.locator('#ed-close').click();
    await page.locator('#write').click();
    await page.waitForFunction(() => window.__written.length === 1 && window.__studio.idle());
    const written = await page.evaluate(() => window.__written[0]);
    assert.equal(written.path, 'Labels/SNES/Chrono Trigger.png');
    const saved = Buffer.from(written.bytes);
    assert.deepEqual([saved.readUInt32BE(16), saved.readUInt32BE(20)], [960, 584]);
    assert.ok(saved.length > 100_000);
    await page.evaluate(async romUrl => {
      const saved = window.__written[0];
      const rom = new File([await (await fetch(romUrl)).blob()], 'Chrono Trigger.smc');
      const png = new File([new Uint8Array(saved.bytes)], 'Chrono Trigger.png');
      Object.defineProperty(rom, 'webkitRelativePath', { value: 'card/Games/SNES/Chrono Trigger.smc' });
      Object.defineProperty(png, 'webkitRelativePath', { value: `card/${saved.path}` });
      await window.__studio.openFiles([rom, png]);
    }, `${base}/rom.smc`);
    await page.waitForFunction(() => window.__studio.idle());
    const [game] = await page.evaluate(() => window.__studio.states());
    assert.equal(game.state, 'has-label');
    assert.equal(game.wears, 'card');
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
  await page.evaluate(() => { window.__writeGate = new Promise(resolve => { window.__releaseWrite = resolve; }); });
  await page.locator('#music-save').click();
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), true);
  assert.equal(await page.locator('#music-editor-window').evaluate(e => e.inert), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), true);
  await page.evaluate(() => window.__releaseWrite());
  await page.waitForFunction(() => window.__written.length === 1);
  await page.waitForFunction(() => !Ext.MessageBox.isVisible());
  assert.equal(await page.locator('#music-editor-window').evaluate(e => e.inert), false);
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
  await page.getByRole('tab', { name: 'Music', exact: true }).click();
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
  await page.locator('#music-hits .x-panel').filter({ hasText: 'Current' }).locator('.music-hit:not(:disabled)').click();
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

test('loading message box masks the app until music metadata and game artwork finish', async (t) => {
  const page = await studio(t);
  let release, began;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { began = resolve; });
  t.after(() => release());
  await page.route(`${base}/vendor/music-metadata.js`, async (route) => { began(); await gate; await route.continue(); });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Games/Music/Folder/one.mp3', `${base}/fixtures/tagged.mp3`]], false, false);
  await started;
  const dialog = page.locator('.studio-progress-dialog');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('#scan-progress').isVisible(), true);
  assert.equal(await page.locator('.ext-el-mask:visible').count(), 1);
  assert.equal(await page.locator('#tabs').evaluate(e => e.inert), true);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true);
  await page.setViewportSize({ width: 400, height: 600 });
  await page.waitForFunction(() => {
    const r = document.querySelector('.studio-progress-dialog').getBoundingClientRect();
    return r.width <= innerWidth - 20 && Math.abs(r.x + r.width / 2 - innerWidth / 2) <= 1;
  });
  await page.waitForTimeout(200);
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.locator('#fill').isVisible(), false);
  await page.screenshot({ path: 'out/browser/loading-messagebox.png' });
  release();
  await page.waitForFunction(() => window.__studio.idle());
  if (await page.locator('#fill').isVisible()) await page.locator('#fill-real').click();
  await page.waitForFunction(() => window.__studio.idle());
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await page.locator('#tabs').evaluate(e => e.inert), false);
  await page.getByRole('tab', { name: 'Music', exact: true }).click();
  await page.locator('.album').click();
  const [album] = await page.evaluate(() => window.__studio.albums());
  assert.notEqual(album.title, 'Folder');
  assert.equal(await page.locator('#music-album').inputValue(), album.title);
  assert.equal(await page.locator('#music-artist').inputValue(), album.artist);
});

test('Download Assets starts the full library before card selection and masks progress until complete', async t => {
  const page = await studio(t, { library: { version: 1, offline: true, onDemand: true, downloadsEnabled: true, platforms: {} } });
  let running = false, complete = false, posts = 0;
  const status = () => ({ running: running && !complete, stage: 'Downloading all five platforms…',
    completed: complete ? 20 : 5, total: 20, available: complete ? 20 : 5, missing: 0, failed: 0, cancelled: false, error: null });
  await page.route('**/api/artwork/status', route => route.fulfill({ json: status() }));
  await page.route('**/api/artwork/download', route => {
    assert.equal(route.request().method(), 'POST'); posts++; running = true;
    return route.fulfill({ json: status() });
  });
  const button = page.getByRole('button', { name: 'Download Assets', exact: true });
  assert.equal(await button.isEnabled(), true);
  await button.click();
  await page.waitForFunction(() => document.querySelector('#studio-header').inert);
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), true);
  assert.equal(await page.locator('#download-assets').isDisabled(), true);
  assert.equal(await page.locator('#pick').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), true);
  complete = true;
  await page.waitForFunction(() => !document.querySelector('#studio-header').inert);
  assert.equal(await button.isEnabled(), true);
  assert.match(await page.locator('#banner-message').innerText(), /20 files ready/);
  assert.equal(posts, 1);
});

test('Download Assets can cancel, retry failures and preserves existing labels and edits', async t => {
  const page = await studio(t, { library: { version: 1, offline: true, onDemand: true, downloadsEnabled: true, platforms: {
    SNES: { database: 'dat/SNES.dat', thumbnails: {} },
  } } });
  let running = false, cancelled = false, posts = 0;
  const status = () => ({ running, stage: 'Downloading assets…', completed: 1, total: 10, available: 1,
    missing: 0, failed: 0, cancelled, error: null });
  await page.route('**/api/artwork/status', route => route.fulfill({ json: status() }));
  await page.route('**/api/artwork/download', route => { posts++; running = true; cancelled = false; return route.fulfill({ json: status() }); });
  await page.route('**/api/artwork/cancel', route => { running = false; cancelled = true; return route.fulfill({ json: status() }); });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Labels/SNES/Probe.png', `${base}/cover.png`]]);
  const before = await page.evaluate(() => window.__studio.states());
  await page.locator('#download-assets').click();
  await page.getByRole('button', { name: 'Cancel download', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#studio-header').inert);
  assert.match(await page.locator('#banner-message').innerText(), /cancelled.*resume/);
  assert.deepEqual(await page.evaluate(() => window.__studio.states()), before);
  await page.route('**/api/artwork/download', route => route.fulfill({ status: 503, json: { error: 'Provider temporarily unavailable' } }));
  await page.locator('#download-assets').click();
  await page.waitForFunction(() => !document.querySelector('#studio-header').inert);
  assert.match(await page.locator('#banner-message').innerText(), /Provider temporarily unavailable/);
  assert.equal(await page.locator('#download-assets').isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__studio.states()), before);
  assert.equal(posts, 1);
});

test('loading waits for delayed artwork and clears its mask when replaced by an empty card', async (t) => {
  const page = await studio(t);
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  t.after(() => release());
  await page.route(`${base}/art/SNES/wheel/**`, async route => { began(); await gate; await route.continue().catch(() => {}); });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`]], false, false);
  await started;
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), true);
  assert.equal(await page.locator('#studio-header').evaluate(e => e.inert), true);
  await openCard(page, [['Games/SNES/readme.txt', `${base}/corrupt.mp3`]], false, false);
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
  assert.equal(await page.locator('#studio-header').evaluate(e => e.inert), false);
  release();
  await page.waitForFunction(() => window.__studio.idle());
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
  assert.match(await page.locator('#banner-message').innerText(), /no games or music/);
  const error = await page.evaluate(async () => {
    try { await window.__studio.openDirectory({ async getDirectoryHandle() { throw new Error('Card disconnected'); } }); }
    catch (e) { return e.message; }
  });
  assert.ok(error);
  assert.equal(await page.locator('.studio-progress-dialog').isVisible(), false);
  assert.equal(await page.locator('#studio-header').evaluate(e => e.inert), false);
});


test('Horizon library cards flow horizontally, wrap and refill rows after platform switching', async (t) => {
  const page = await studio(t);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openCard(page, [
    ...Array.from({ length: 7 }, (_, i) => [`Games/SNES/Probe ${i + 1}.smc`, `${base}/rom.smc`]),
    ['Games/Music/Album/one.mp3', `${base}/corrupt.mp3`],
  ]);
  const positions = () => page.locator('#grid > .cart:not([hidden])').evaluateAll(cards =>
    cards.map(card => { const r = card.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right }; }));
  let cards = await positions();
  assert.equal(cards.length, 7);
  assert.equal(cards[0].y, cards[1].y);
  assert.ok(cards[1].x > cards[0].right);
  assert.ok(cards[6].y > cards[0].y);
  const libraryFrame = await page.locator('#studio-library').boundingBox();
  const statusFrame = await page.locator('#studio-status').boundingBox();
  assert.ok(libraryFrame.y + libraryFrame.height <= statusFrame.y);
  await page.screenshot({ path: 'out/browser/library-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForFunction(() => Ext.getCmp('tabs').getSize().width <= 400);
  cards = await positions();
  assert.equal(cards[0].y, cards[1].y);
  assert.ok(cards[1].x > cards[0].right);
  assert.ok(cards[2].y > cards[0].y);
  assert.ok(cards.every(card => card.x >= 0 && card.right <= 400));
  await page.screenshot({ path: 'out/browser/library-mobile.png', fullPage: true });
  await page.locator('#tabs [role="tab"]:visible').filter({ hasText: 'Music' }).click();
  cards = await positions();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].x, (await page.locator('#grid').boundingBox()).x);
  await page.locator('#tabs [role="tab"]:visible').filter({ hasText: 'SNES' }).click();
  assert.equal((await positions()).length, 7);
});

test('Viewport keeps controls fixed while its library scrolls and resizes around notices', async (t) => {
  const page = await studio(t);
  await page.setViewportSize({ width: 1280, height: 720 });
  assert.equal(await page.evaluate(() => Ext.getCmp('studio-viewport') instanceof Ext.Viewport), true);
  assert.equal(await page.locator('#studio-workspace').count(), 0);
  assert.equal(await page.evaluate(() => Ext.getCmp('tabs').ownerCt === Ext.getCmp('studio-viewport')), true);
  const games = Array.from({ length: 14 }, (_, i) =>
    [`Games/SNES/Probe ${i + 1}.smc`, `${base}/rom.smc`]);
  await openCard(page, games);
  const fixed = async () => [
    await page.locator('#studio-header .x-panel-header').first().boundingBox(),
    await page.locator('#studio-status').boundingBox(),
    await page.locator('#studio-header .x-panel-tbar').first().boundingBox(),
  ];
  const before = await fixed();
  const scrolled = await page.evaluate(() => {
    const body = Ext.getCmp('studio-library').body.dom;
    body.scrollTop = 500;
    return body.scrollTop;
  });
  assert.ok(scrolled > 0);
  assert.deepEqual(await fixed(), before);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.locator('.cart').first().click();
  await page.locator('#ed-file').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('invalid') });
  await page.locator('#banner-message').getByText(/not a PNG/).waitFor();
  await page.locator('#ed-close').click();
  const notice = await page.locator('#banner').boundingBox();
  const shortened = await page.locator('#studio-library').boundingBox();
  assert.ok(shortened.y >= notice.y + notice.height, JSON.stringify({ notice, shortened,
    header: await page.locator('#studio-header').boundingBox() }));
  assert.deepEqual(await fixed(), before);
  await openCard(page, games.slice(0, 1));
  const expanded = await page.locator('#studio-library').boundingBox();
  assert.ok(expanded.height > shortened.height);
  await page.setViewportSize({ width: 400, height: 600 });
  await page.waitForFunction(() => document.getElementById('studio-status').getBoundingClientRect().bottom === innerHeight);
  const status = await page.locator('#studio-status').boundingBox();
  const library = await page.locator('#studio-library').boundingBox();
  assert.equal(status.y + status.height, 600);
  assert.ok(library.x + library.width <= 400);
  assert.ok(library.y + library.height <= status.y);
  await page.screenshot({ path: 'out/browser/viewport-mobile.png', fullPage: true });
});

test('native TabPanel preserves edited cards and supports keyboard navigation and tab scrolling', async (t) => {
  const page = await studio(t);
  await openCard(page, [
    ['Games/GBA/Advance.gba', `${base}/rom.smc`],
    ['Games/GBC/Colour.gbc', `${base}/rom.smc`],
    ['Games/GB/Classic.gb', `${base}/rom.smc`],
    ['Games/SNES/Probe.smc', `${base}/rom.smc`],
    ['Games/PSX/Disc.chd', `${base}/rom.smc`],
    ['Games/Music/Album/one.mp3', `${base}/corrupt.mp3`],
  ]);
  assert.equal(await page.evaluate(() => Ext.getCmp('tabs') instanceof Ext.TabPanel), true);
  const tabs = page.getByRole('tab');
  assert.equal(await tabs.count(), 6);
  assert.deepEqual(await tabs.allTextContents(), ['GBA 1', 'GBC 1', 'GB 1', 'PSX 1', 'SNES 1', 'Music 1']);
  const snes = page.getByRole('tab', { name: 'Super Nintendo' });
  await snes.click();
  assert.equal(await page.getByRole('tabpanel', { name: 'Super Nintendo' }).isVisible(), true);
  await page.locator('.cart:not([hidden])').click();
  await page.locator('#choose-logo').click();
  await page.locator('#ed-bg-custom').fill('#336699');
  await page.locator('#ed-bg-auto').focus();
  const edited = (await page.evaluate(() => window.__studio.states())).find(c => c.stem === 'Probe').deep;
  await page.evaluate(() => { window.__keptCanvas = document.querySelector('.cart:not([hidden]) canvas'); });
  await page.locator('#ed-close').click();
  await snes.focus();
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: 'Music', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.__studio.editing()), null);
  await page.keyboard.press('Home');
  assert.equal(await page.getByRole('tab', { name: 'Game Boy Advance' }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Game Boy Color' }).getAttribute('aria-selected'), 'true');
  await snes.click();
  assert.equal(await page.evaluate(() => window.__keptCanvas === document.querySelector('.cart:not([hidden]) canvas')), true);
  assert.equal((await page.evaluate(() => window.__studio.states())).find(c => c.stem === 'Probe').deep, edited);
  await page.setViewportSize({ width: 260, height: 800 });
  await page.waitForFunction(() => Ext.getCmp('tabs').scrolling === true);
  await snes.focus();
  await page.keyboard.press('End');
  const music = page.getByRole('tab', { name: 'Music', exact: true });
  const bounds = await music.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 260);
  await page.screenshot({ path: 'out/browser/platform-tabs-mobile.png', fullPage: true });
});

test('clicked items open centered masked editors that resize and unmask on close', async (t) => {
  const page = await studio(t);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openCard(page, [['Games/SNES/Probe.smc', `${base}/rom.smc`], ['Games/Music/Album/one.mp3', `${base}/corrupt.mp3`]]);
  const centered = async id => {
    const bounds = await page.locator('#' + id).boundingBox(), size = page.viewportSize();
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - size.width / 2) <= 1);
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - size.height / 2) <= 1);
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width && bounds.y + bounds.height <= size.height);
  };
  await page.locator('.cart:not(.album)').click();
  await centered('cart-editor-window');
  assert.equal(await page.locator('#cart-editor-window').getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('.ext-el-mask:visible').count(), 1);
  assert.equal(await page.locator('#tabs').evaluate(e => e.inert), true);
  const backgroundTab = await page.locator('#platform-Music-tab').boundingBox();
  await page.mouse.click(backgroundTab.x + backgroundTab.width / 2, backgroundTab.y + backgroundTab.height / 2);
  assert.equal(await page.evaluate(() => Ext.getCmp('tabs').getActiveTab().platformId), 'SNES');
  await page.setViewportSize({ width: 400, height: 600 });
  await page.waitForFunction(() => {
    const r = document.getElementById('cart-editor-window').getBoundingClientRect();
    return Math.abs(r.x + r.width / 2 - innerWidth / 2) <= 1 && Math.abs(r.y + r.height / 2 - innerHeight / 2) <= 1;
  });
  await centered('cart-editor-window');
  await page.screenshot({ path: 'out/browser/cart-modal-mobile.png', fullPage: true });
  await page.locator('#ed-close').click();
  assert.equal(await page.locator('.ext-el-mask:visible').count(), 0);
  assert.equal(await page.locator('#tabs').evaluate(e => e.inert), false);
  await page.getByRole('tab', { name: 'Music', exact: true }).click();
  await page.locator('.album').click();
  await centered('music-editor-window');
  assert.equal(await page.locator('.ext-el-mask:visible').count(), 1);
  assert.equal(await page.locator('#studio-header').evaluate(e => e.inert), true);
  await page.waitForFunction(() => document.getElementById('music-editor-window').contains(document.activeElement));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#music-editor-window').isVisible(), false);
  assert.equal(await page.locator('.ext-el-mask:visible').count(), 0);
  assert.equal(await page.locator('#studio-header').evaluate(e => e.inert), false);
});

test('complete Horizon viewport is unbranded and the fallback chooser remains usable', async (t) => {
  const page = await studio(t, { fallback: true });
  assert.equal(await page.title(), 'Cart Studio');
  assert.deepEqual(await page.evaluate(() => [
    Ext.getCmp('tabs') instanceof Ext.TabPanel,
    Ext.getCmp('grid') instanceof Ext.DataView,
    Ext.getCmp('editor') instanceof Ext.FormPanel,
    Ext.getCmp('music-editor') instanceof Ext.FormPanel,
    Ext.getCmp('fill') instanceof Ext.Window,
  ]), [true, true, true, true, true]);
  await page.locator('#about').click();
  assert.equal(await page.getByText('About Cart Studio', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('a[href="vendor/horizonjs/LICENSE.txt"]').isVisible(), true);
  assert.equal(/slot\./i.test(await page.locator('body').innerText()), false);
  await page.locator('.x-window:visible .x-tool-close').click();
  const choose = page.waitForEvent('filechooser');
  await page.locator('#pick').click();
  const picker = await choose;
  assert.equal(await picker.element().getAttribute('webkitdirectory'), '');
  await page.screenshot({ path: 'out/browser/horizon-initial.png' });
});

test('Horizon cartridge forms apply imported logos, colours, presets and history', async (t) => {
  const page = await studio(t, {
    artIndex: { [rawCrc]: { wheel: 'GBA/wheel/probe.png', 'support-texture': 'GBA/support-texture/probe.png' } },
    dat: `game (\n name "GBA Probe (USA)"\n rom ( name "Probe.gba" crc ${rawCrc} )\n)\n`,
  });
  await openCard(page, [['Games/GBA/Probe.gba', `${base}/rom.smc`]]);
  await page.locator('.cart').click();
  await page.waitForFunction(() => document.getElementById('cart-editor-window').contains(document.activeElement));
  await page.locator('#ed-game').fill('Probe');
  await page.locator('.x-combo-list-item').filter({ hasText: 'GBA Probe (USA)' }).click();
  assert.equal(await page.locator('#ed-undo').isDisabled(), true);
  await page.locator('#ed-game').locator('..').locator('.x-form-trigger').click();
  await page.locator('.x-combo-list-item').filter({ hasText: 'No match' }).click();
  assert.equal(await page.locator('#ed-undo').isDisabled(), false);
  await page.locator('#ed-undo').click();
  await page.locator('#ed-shell-presets').locator('..').locator('.x-form-trigger').click();
  await page.locator('.x-combo-list:visible .x-combo-list-item').first().click();
  assert.notEqual((await page.evaluate(() => window.__studio.shells()))[0].shell, '');
  await page.locator('#ed-undo').click();
  const file = page.waitForEvent('filechooser');
  await page.locator('#choose-customLogo').click();
  await (await file).setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => window.__studio.states()[0].wears === 'customLogo');
  await page.locator('#ed-bg-custom').fill('#123456');
  await page.locator('#ed-bg-auto').focus();
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].deep, '#123456');
  await page.locator('#ed-bg-palette').focus();
  await page.keyboard.press('Control+z');
  assert.notEqual((await page.evaluate(() => window.__studio.states()))[0].deep, '#123456');
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].deep, '#123456');
  await page.locator('#ed-shell-custom').fill('#336699');
  await page.locator('#ed-shell-auto').focus();
  assert.match((await page.evaluate(() => window.__studio.shells()))[0].shell, /336699 solid$/);
  await page.locator('#ed-undo').click();
  assert.equal((await page.evaluate(() => window.__studio.shells()))[0].shell, '');
  await page.locator('#ed-redo').click();
  assert.match((await page.evaluate(() => window.__studio.shells()))[0].shell, /336699 solid$/);
  await page.locator('#ed-bg-palette').click();
  await page.locator('.x-color-palette a').first().click();
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].deep, '#000000');
  await page.locator('#ed-revert').click();
  assert.equal((await page.evaluate(() => window.__studio.states()))[0].wears, 'real');
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(150);
  const bounds = await page.locator('#cart-editor-window').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 400);
  await page.locator('#editor .x-panel-body').first().evaluate(e => { e.scrollTop = 0; });
  await page.screenshot({ path: 'out/browser/cart-editor-mobile.png' });
  await page.locator('#ed-close').click();
  assert.equal(await page.evaluate(() => window.__studio.editing()), null);
});
