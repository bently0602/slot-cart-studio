import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copierHeaderSize, matchedChecksum, romChecksums } from './snes.js';
class Hash {
  value = 0;
  update(bytes) { for (const b of bytes) this.value += b; }
  finish() { return this.value; }
  free() {}
}
test('SNES hashes raw bytes and skips a copier header across stream chunks', async () => {
  const bytes = new Uint8Array(32768 + 512).fill(1);
  const file = { size: bytes.length, stream: () => new ReadableStream({ start(c) {
    c.enqueue(bytes.slice(0, 17)); c.enqueue(bytes.slice(17, 513)); c.enqueue(bytes.slice(513)); c.close();
  } }) };
  assert.deepEqual(await romChecksums(file, 'SNES', Hash), { crc: 33280, bareCrc: 32768 });
  assert.deepEqual(await romChecksums(file, 'GBA', Hash), { crc: 33280, bareCrc: null });
  for (const size of [0, 512, 32768, 32769]) assert.equal(copierHeaderSize(size), 0);
  assert.equal(copierHeaderSize(65536 + 512), 512);
});
test('raw matches win; headerless lookup is a fallback', () => {
  const db = { game_for: (crc) => new Map([[1, 'Raw'], [2, 'Bare']]).get(crc) };
  assert.deepEqual(matchedChecksum(db, 1, 2), { game: 'Raw', crc: 1 });
  assert.deepEqual(matchedChecksum(db, 3, 2), { game: 'Bare', crc: 2 });
  assert.equal(matchedChecksum(db, 3, null), null);
});
