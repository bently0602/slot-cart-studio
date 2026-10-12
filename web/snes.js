// Both lookups retain the ROM's original stem. Header removal is only for identification.
export function copierHeaderSize(size) {
  return size > 512 && size % 32768 === 512 ? 512 : 0;
}

export async function romChecksums(file, platform, Crc32) {
  let raw = new Crc32();
  const offset = platform === 'SNES' ? copierHeaderSize(file.size) : 0;
  let bare = offset ? new Crc32() : null;
  const reader = file.stream().getReader();
  let position = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw.update(value);
      if (bare && position + value.length > offset) bare.update(value.subarray(Math.max(0, offset - position)));
      position += value.length;
    }
    const crc = raw.finish();
    raw = null;
    const bareCrc = bare ? bare.finish() : null;
    bare = null;
    return { crc, bareCrc };
  } finally {
    reader.releaseLock();
    raw?.free?.();
    bare?.free?.();
  }
}

export function matchedChecksum(db, crc, bareCrc) {
  for (const value of [crc, bareCrc]) {
    if (value == null) continue;
    const game = db.game_for(value);
    if (game) return { game, crc: value };
  }
  return null;
}
