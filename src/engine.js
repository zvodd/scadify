// openscad-wasm-prebuilt wrapper: recipe -> mesh. A fresh WASM instance per part keeps compiles hermetic.
import { createHash } from 'node:crypto';
import { createOpenSCAD } from 'openscad-wasm-prebuilt';
import { toScadParts, defineArgs, declareHeader, partTint, recipeHash } from './recipe.js';

const cache = new Map();

async function compilePart(source, defs) {
  const log = [];
  const o = await createOpenSCAD({ print: (t) => log.push(t), printErr: (t) => log.push(t) });
  const inst = o.getInstance();
  inst.FS.writeFile('/in.scad', source);
  let code = 0;
  try {
    code = inst.callMain(['/in.scad', '--backend=manifold', ...defs, '-o', '/out.stl']);
  } catch (e) {
    code = typeof e?.status === 'number' ? e.status : 1;
    log.push(String(e?.message ?? e));
  }
  let off = null;
  try { off = inst.FS.readFile('/out.stl', { encoding: 'utf8' }); } catch { /* not produced */ }
  if (code !== 0 || !off) {
    const msg = log.filter((l) => /ERROR|error|Parser/.test(l)).join('\n') || log.slice(-5).join('\n');
    throw new Error(`openscad failed: ${msg || 'no output (empty geometry?)'}`);
  }
  return parseStl(off);
}

// ASCII STL (always triangles; OFF can carry concave polygons). Vertices are welded by exact printed value.
function parseStl(text) {
  const pos = []; const idx = []; const seen = new Map();
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m; let corner = 0; const tri = [];
  while ((m = re.exec(text))) {
    const key = `${m[1]} ${m[2]} ${m[3]}`;
    let i = seen.get(key);
    if (i === undefined) { i = pos.length / 3; seen.set(key, i); pos.push(+m[1], +m[2], +m[3]); }
    tri.push(i);
    if (++corner === 3) { corner = 0; if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) idx.push(...tri); tri.length = 0; }
  }
  if (!idx.length) throw new Error('empty geometry');
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** Compile a normalized recipe -> { parts:[{name,tint,positions,indices}], checksum }. */
export async function compile(recipe) {
  const key = recipeHash(recipe);
  if (cache.has(key)) return cache.get(key);
  const { program, partCode } = toScadParts(recipe);
  const defs = defineArgs(recipe);
  const parts = [];
  for (const name of Object.keys(recipe.parts)) {
    const m = await compilePart(`${declareHeader(recipe)}\n${program}\n${partCode[name]}\n`, defs);
    parts.push({ name, tint: partTint(recipe, name), ...m });
  }
  const mesh = { parts, checksum: meshChecksum(parts) };
  cache.set(key, mesh);
  return mesh;
}

export function meshChecksum(parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p.name);
    h.update(Buffer.from(p.positions.buffer, p.positions.byteOffset, p.positions.byteLength));
    h.update(Buffer.from(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength));
  }
  return h.digest('hex');
}

export function measure(mesh) {
  const total = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let volume = 0, area = 0, tris = 0;
  const parts = mesh.parts.map((p) => {
    const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const P = p.positions;
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) {
      bb.min[a] = Math.min(bb.min[a], P[i + a]); bb.max[a] = Math.max(bb.max[a], P[i + a]);
    }
    let v = 0, ar = 0;
    for (let t = 0; t < p.indices.length; t += 3) {
      const a = p.indices[t] * 3, b = p.indices[t + 1] * 3, c = p.indices[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      ar += Math.hypot(nx, ny, nz) / 2;
      v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    for (let a = 0; a < 3; a++) { total.min[a] = Math.min(total.min[a], bb.min[a]); total.max[a] = Math.max(total.max[a], bb.max[a]); }
    volume += v; area += ar; tris += p.indices.length / 3;
    return { name: p.name, bbox: { min: bb.min.map(round), max: bb.max.map(round) }, volume_mm3: round(v), triangles: p.indices.length / 3 };
  });
  return {
    bbox: { min: total.min.map(round), max: total.max.map(round) }, size: total.max.map((m, i) => round(m - total.min[i])),
    volume_mm3: round(volume), surface_area_mm2: round(area), triangles: tris, parts, checksum: mesh.checksum,
  };
}
const round = (x) => Math.round(x * 1e4) / 1e4;
