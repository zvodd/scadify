// Binary STL, all parts merged, written in MILLIMETRES (print convention) whatever the recipe unit. Fixed header -> deterministic.
import { metersPerUnit } from '../recipe.js';

export function emitSTL(recipe, mesh) {
  const k = metersPerUnit(recipe) * 1000; // recipe units -> mm (1 for mm recipes, so their bytes are unchanged)
  const n = mesh.parts.reduce((a, p) => a + p.indices.length / 3, 0);
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(`scadify ${recipe.title}`.slice(0, 80), 0, 'latin1');
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (const { positions: P0, indices: I } of mesh.parts) {
    const P = k === 1 ? P0 : Float64Array.from(P0, (v) => v * k);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]) { buf.writeFloatLE(v, o); o += 4; }
      o += 2;
    }
  }
  return buf;
}
