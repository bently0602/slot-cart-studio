import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

test('desktop serves the packaged WASM and parser and scans a tagged album', {
  skip: process.platform !== 'win32' && process.platform !== 'darwin' && !process.env.STUDIO_DESKTOP,
  timeout: 30000,
}, async (t) => {
  const executable = resolve(process.env.STUDIO_DESKTOP ?? (process.platform === 'win32' ?
    'dist/windows-x64/slot-cart-studio.exe' : 'dist/macos-arm64/slot-cart-studio'));
  const child = spawn(executable, ['--no-open'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const base = await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Desktop exited before startup: ${code}`)));
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/Cart Studio is at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) resolve(match[1]);
    });
  });
  for (const path of ['pkg/slot_cart_studio_bg.wasm', 'vendor/music-metadata.js', 'studio.js', 'music-editor.js']) {
    const response = await fetch(new URL(path, base));
    assert.equal(response.status, 200, path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(resolve('web', path)), path);
  }
  const config = await (await fetch(new URL('config.js', base))).text();
  assert.ok(config.includes("new URL('/api/music/', location.origin).href"));
  assert.ok(!config.includes('studio.slot-cfw.fyi'));
  const invalid = await fetch(new URL('api/music/search?album=', base));
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).error);
  const post = await fetch(new URL('api/music/search?album=Album', base), { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  const browser = await chromium.launch({ headless: true, ...(process.env.STUDIO_CHROME ? { executablePath: process.env.STUDIO_CHROME } :
    process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('https://art.slot-cfw.fyi/**', (route) => route.fulfill({ json: {} }));
  let searchUrl;
  await page.route('**/api/music/search?**', (route) => {
    searchUrl = new URL(route.request().url());
    return route.fulfill({ json: { candidates: [{ id: '48117b90-a16e-34ca-a514-19c702df1158', title: 'Suggested', artist: 'Artist' }] } });
  });
  await page.route('https://coverartarchive.org/**', (route) => route.fulfill({ contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGO0snJiYGAAAAOUALgNWObMAAAAAElFTkSuQmCC', 'base64') }));
  await page.goto(base);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const bytes = [...await readFile('tests/fixtures/music/tagged.mp3')];
  await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], 'track.mp3');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'card/Games/Music/Folder/track.mp3' });
    await window.__studio.openFiles([file]);
  }, bytes);
  await page.waitForFunction(() => window.__studio.idle());
  const [album] = await page.evaluate(() => window.__studio.albums());
  assert.notEqual(album.title, 'Folder');
  assert.notEqual(album.artist, 'Unknown Artist');
  assert.equal(album.path, 'Games/Music/Folder');
  await page.locator('.album').click();
  await page.locator('.music-hit:not(:disabled)').first().click();
  await page.waitForFunction(() => window.__studio.albums()[0].ready);
  assert.equal(searchUrl.origin, new URL(base).origin);
  assert.equal(searchUrl.pathname, '/api/music/search');
  assert.deepEqual(errors, []);
});
