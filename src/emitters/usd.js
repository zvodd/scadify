// USDA text + USDZ (uncompressed zip, 64-byte aligned). Z-up, coordinates in METRES (metersPerUnit = 1). One Xform per part, named after the part, holding a Mesh with the same name.
import { zip } from './zip.js';
import { slug } from '../recipe.js';
import { positionsInMeters, uniqueNames } from './common.js';

const hex = (h) => [1, 3, 5].map((i) => +(parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4));
const g = (x) => String(+x.toPrecision(7));
const ident = (s) => { const t = String(s).replace(/[^A-Za-z0-9_]/g, '_'); return /^[A-Za-z_]/.test(t) ? t : `_${t}`; };

export function emitUSDA(recipe, mesh) {
  const root = ident(slug(recipe.title).replace(/-/g, '_'));
  let body = '';
  let mats = '';
  const names = uniqueNames(mesh.parts.map((p) => ident(p.name)), ['Materials']); // 'Materials' is the sibling Scope
  for (const [pi, p] of mesh.parts.entries()) {
    const n = names[pi]; const c = hex(p.tint);
    const P = positionsInMeters(p.positions, recipe); const pts = []; for (let i = 0; i < P.length; i += 3) pts.push(`(${g(P[i])}, ${g(P[i + 1])}, ${g(P[i + 2])})`);
    const ext = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { ext[0][a] = Math.min(ext[0][a], P[i + a]); ext[1][a] = Math.max(ext[1][a], P[i + a]); }
    body += `    def Xform "${n}"\n    {\n        def Mesh "${n}"\n        {\n` +
      `            int[] faceVertexCounts = [${new Array(p.indices.length / 3).fill(3).join(', ')}]\n` +
      `            int[] faceVertexIndices = [${Array.from(p.indices).join(', ')}]\n` +
      `            point3f[] points = [${pts.join(', ')}]\n` +
      `            float3[] extent = [(${ext[0].map(g).join(', ')}), (${ext[1].map(g).join(', ')})]\n` +
      `            uniform token subdivisionScheme = "none"\n            uniform bool doubleSided = 0\n` +
      `            color3f[] primvars:displayColor = [(${c.join(', ')})]\n` +
      `            rel material:binding = </${root}/Materials/${n}>\n        }\n    }\n`;
    mats += `        def Material "${n}"\n        {\n            token outputs:surface.connect = </${root}/Materials/${n}/pbr.outputs:surface>\n` +
      `            def Shader "pbr"\n            {\n                uniform token info:id = "UsdPreviewSurface"\n` +
      `                color3f inputs:diffuseColor = (${c.join(', ')})\n                float inputs:metallic = 0\n                float inputs:roughness = 0.6\n` +
      `                token outputs:surface\n            }\n        }\n`;
  }
  return `#usda 1.0\n(\n    defaultPrim = "${root}"\n    metersPerUnit = 1\n    upAxis = "Z"\n    doc = "scadify: ${recipe.title.replace(/["\\\n]/g, ' ')}"\n)\n\n` +
    `def Xform "${root}"\n{\n${body}    def Scope "Materials"\n    {\n${mats}    }\n}\n`;
}

export function emitUSDZ(recipe, mesh) {
  const usda = emitUSDA(recipe, mesh);
  return zip([{ name: `${slug(recipe.title)}.usda`, data: usda }], { align: 64 });
}
