import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

// HorizonJS is a pinned local distribution rather than a CDN dependency. Verify
// its upstream assets before copying the runtime, readable source, and notices.
const horizonSource = 'third_party/horizonjs';
const horizon = JSON.parse(await readFile(join(horizonSource, 'checksums.json'), 'utf8'));
for (const [file, expected] of Object.entries(horizon.files)) {
  const bytes = await readFile(join(horizonSource, file));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`HorizonJS integrity check failed: ${file}`);
  }
}
await mkdir('web/vendor', { recursive: true });
await cp(horizonSource, 'web/vendor/horizonjs', { recursive: true });

// The metadata parser is bundled; studio modules remain directly readable.
const result = await build({
  entryPoints: ['web/music-metadata.js'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'web/vendor/music-metadata.js',
  minify: true,
  legalComments: 'eof',
  metafile: true,
  write: false,
});

// Keep the full dependency notices with the asset that desktop builds embed.
const packages = new Set(Object.keys(result.metafile.inputs).map((path) => {
  const match = [...path.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].at(-1);
  return match && path.slice(0, match.index + match[0].length);
}).filter(Boolean));
const notices = [];
for (const path of [...packages].sort()) {
  const info = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  let license;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'license.md']) {
    try { license = await readFile(join(path, name), 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license) throw new Error(`Missing bundled license for ${info.name}`);
  notices.push(`${info.name} ${info.version}\n${license}`);
}
const output = result.outputFiles[0];
await mkdir(dirname(output.path), { recursive: true });
await writeFile(output.path, `${output.text}\n/*! Dependency notices\n${notices.join('\n\n').replace(/\*\//g, '* /')}\n*/\n`);
