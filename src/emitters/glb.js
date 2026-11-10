// Clean GLB: mesh only. Flat tree = one node per part (mesh under it). No cameras, lights, ground, hierarchy.
// Coordinates are written in METRES (recipe units scaled by the unit's metres-per-unit), z-up; asset.extras records units 'm' / metersPerUnit 1
// since glTF has no ratified units extension. Node, mesh and material names are the part names.
import { positionsInMeters, uniqueNames } from './common.js';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const pad4 = (b, fill = 0) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);

function build(recipe, mesh) {
  const bufs = []; const bufferViews = []; const accessors = []; const meshes = []; const nodes = []; const materials = [];
  let len = 0;
  const view = (b, target) => { const bb = pad4(b); bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.length, target }); bufs.push(bb); len += bb.length; return bufferViews.length - 1; };
  const names = uniqueNames(mesh.parts.map((p) => p.name));
  for (const [pi, part] of mesh.parts.entries()) {
    const p = { ...part, positions: positionsInMeters(part.positions, recipe) }; const name = names[pi];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.positions.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p.positions[i + a]); max[a] = Math.max(max[a], p.positions[i + a]); }
    const pv = view(Buffer.from(p.positions.buffer, p.positions.byteOffset, p.positions.byteLength), 34962);
    accessors.push({ bufferView: pv, componentType: 5126, count: p.positions.length / 3, type: 'VEC3', min, max });
    const iv = view(Buffer.from(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength), 34963);
    accessors.push({ bufferView: iv, componentType: 5125, count: p.indices.length, type: 'SCALAR' });
    materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [...hex(p.tint), 1], metallicFactor: 0, roughnessFactor: 0.6 } });
    meshes.push({ name, primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1, material: materials.length - 1, mode: 4 }] });
    nodes.push({ name, mesh: meshes.length - 1 });
  }
  const json = {
    asset: { version: '2.0', generator: 'scadify', extras: { units: 'm', metersPerUnit: 1, sourceUnits: recipe.units, upAxis: 'Z', title: recipe.title } },
    scene: 0, scenes: [{ name: recipe.title, nodes: nodes.map((_, i) => i) }],
    nodes, meshes, materials, accessors, bufferViews, buffers: [{ byteLength: len }],
  };
  return { json, bin: Buffer.concat(bufs) };
}

export function emitGLTF(recipe, mesh) {
  const { json, bin } = build(recipe, mesh);
  json.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
  return JSON.stringify(json, null, 1) + '\n';
}

export function emitGLB(recipe, mesh) {
  const { json, bin } = build(recipe, mesh);
  const j = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const total = 12 + 8 + j.length + 8 + bin.length;
  const h = Buffer.alloc(12 + 8); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(total, 8); h.writeUInt32LE(j.length, 12); h.writeUInt32LE(0x4e4f534a, 16);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, j, bh, bin]);
}
