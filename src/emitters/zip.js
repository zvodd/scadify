// Minimal deterministic ZIP writer (stored entries, fixed timestamp). Optional per-entry data alignment (USDZ needs 64).
const T = new Uint32Array(256).map((_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }

/** entries: [{name, data: Buffer|string}] -> Buffer */
export function zip(entries, { align = 0 } = {}) {
  const chunks = []; const central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data);
    let extra = Buffer.alloc(0);
    if (align) { // pad via a 0xFFFF extra field so data starts on an `align` boundary (field header is 4 bytes)
      const base = off + 30 + name.length;
      let pad = (align - (base % align)) % align;
      if (pad > 0 && pad < 4) pad += align;
      if (pad) { extra = Buffer.alloc(pad); extra.writeUInt16LE(0xffff, 0); extra.writeUInt16LE(pad - 4, 2); }
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); // 1980-01-01 00:00
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(extra.length, 28);
    chunks.push(h, name, extra, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, name);
    off += 30 + name.length + extra.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cd, end]);
}

/** Read stored/deflated entries back (used by tests). */
export function unzip(buf) {
  const out = {}; let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (method !== 0) throw new Error('unzip: only stored supported');
    out[name] = { data: buf.subarray(ds, ds + csize), offset: ds };
    p += 46 + nl + el + cl;
  }
  return out;
}
