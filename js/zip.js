/*
 * Minimal ZIP reader for the browser.
 * Reads the central directory and inflates entries with the native DecompressionStream,
 * so no third-party library is needed. Supports STORED (0) and DEFLATE (8) entries.
 */
'use strict';

const Zip = (() => {
  const EOCD_SIG = 0x06054b50;
  const CDIR_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;

  /** Open a zip archive held in an ArrayBuffer. Returns {names, has(name), read(name) -> Promise<ArrayBuffer>}. */
  function open(buffer) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const len = buffer.byteLength;

    // The end-of-central-directory record sits in the last 22..65557 bytes.
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error('ZIP64 archives are not supported');

    const utf8 = new TextDecoder();
    const entries = new Map();
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== CDIR_SIG) throw new Error('Corrupt zip central directory');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));
      if (csize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 entries are not supported');
      entries.set(name, { name, method, csize, usize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    async function read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`"${name}" not found in archive`);
      const lo = e.localOffset;
      if (dv.getUint32(lo, true) !== LOCAL_SIG) throw new Error(`Corrupt local header for "${name}"`);
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return data.slice().buffer;
      if (e.method !== 8) throw new Error(`Unsupported compression method ${e.method} for "${name}"`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).arrayBuffer();
    }

    return { names: [...entries.keys()], has: (n) => entries.has(n), read };
  }

  return { open };
})();
