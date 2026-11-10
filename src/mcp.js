// Hand-rolled stdio MCP server (newline-delimited JSON-RPC 2.0). No SDK.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Store, defaultOutDir, checkRef } from './store.js';
import { compile, measure } from './engine.js';
import { emitGLB, emitGLTF } from './emitters/glb.js';
import { emitSTL } from './emitters/stl.js';
import { emit3MF } from './emitters/threemf.js';
import { emitUSDA, emitUSDZ } from './emitters/usd.js';
import { emitSCAD } from './emitters/scad.js';
import { renderTurntable, renderFrame, renderStandard, encodePNG, parseBackground, STUDIO_BG, STANDARD_PANELS } from './raster.js';
import { canonical } from './recipe.js';

const VERSION = '0.1.0';
export const FORMATS = {
  glb: emitGLB, gltf: emitGLTF, stl: emitSTL, '3mf': emit3MF, usdz: emitUSDZ, usda: emitUSDA, scad: emitSCAD,
  json: (recipe) => JSON.stringify(JSON.parse(canonical(recipe)), null, 2) + '\n',
};

const recipeSchema = {
  type: 'object', description: 'Recipe: {kind:"scad"|"csg", title, units:"mm|cm|dm|m" (default dm), seed, params, program+parts (scad) | tree/parts (csg), tints}',
  properties: { kind: { enum: ['scad', 'csg'] }, title: { type: 'string' }, units: { enum: ['mm', 'cm', 'dm', 'm'] }, seed: { type: 'integer' }, program: { type: 'string' }, parts: { type: 'object' }, tree: { type: 'object' }, params: { type: 'object' }, tints: { type: 'object' } },
};
const refProp = { ref: { type: 'string', description: 'Solid ref returned by mint_solid' } };

export const TOOLS = [
  { name: 'mint_solid', description: 'Store a recipe (the source of truth; meshes are never stored). Returns { ref }.', inputSchema: { type: 'object', properties: { recipe: recipeSchema }, required: ['recipe'] } },
  { name: 'list_solids', description: 'List stored solid refs and titles.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_solid', description: 'Return the stored recipe JSON.', inputSchema: { type: 'object', properties: refProp, required: ['ref'] } },
  { name: 'update_solid', description: 'Edit a stored recipe in place: params merge; program/parts/tree/title/seed/tints replace.', inputSchema: { type: 'object', properties: { ...refProp, params: { type: 'object' }, program: { type: 'string' }, parts: { type: 'object' }, tree: { type: 'object' }, title: { type: 'string' }, seed: { type: 'integer' }, tints: { type: 'object' } }, required: ['ref'] } },
  { name: 'export_solid', description: 'Compile deterministically and write a file. Returns { path, format, sizeBytes, sha256, ref }.', inputSchema: { type: 'object', properties: { ...refProp, format: { enum: Object.keys(FORMATS) } }, required: ['ref', 'format'] } },
  { name: 'render_turntable', description: 'Render 3-36 turntable PNG frames in-process (software rasterizer). Returns frame paths.', inputSchema: { type: 'object', properties: { ...refProp, frames: { type: 'integer', minimum: 3, maximum: 36 }, size: { type: 'integer', minimum: 32, maximum: 1024 }, elevation_deg: { type: 'number' } }, required: ['ref'] } },
  { name: 'render_shot', description: 'Render exactly one PNG from a chosen azimuth + elevation (software rasterizer). angle_deg 0 = the model front (-y); positive turns the camera around +z. Returns { path, size }.', inputSchema: { type: 'object', properties: { ...refProp, angle_deg: { type: 'number' }, elevation_deg: { type: 'number', minimum: -89, maximum: 89 }, size: { type: 'integer', minimum: 32, maximum: 1024 }, background: { type: 'string', description: "#rrggbb or 'transparent' (default #0C1019)" } }, required: ['ref'] } },
  { name: 'render_standard', description: 'Standard preview: one square PNG with a front-on shot (left) and an angled-high shot (right) side by side on the studio background. Returns { path, size, panels }.', inputSchema: { type: 'object', properties: { ...refProp, size: { type: 'integer', minimum: 64, maximum: 2048 }, background: { type: 'string', description: "#rrggbb or 'transparent' (default #0C1019)" } }, required: ['ref'] } },
  { name: 'measure_solid', description: 'Bounding box, volume, area and mesh checksum of the compiled solid (determinism gate).', inputSchema: { type: 'object', properties: refProp, required: ['ref'] } },
];

const sha = (b) => createHash('sha256').update(b).digest('hex');

export function makeHandlers({ store = new Store(), outDir = defaultOutDir() } = {}) {
  const load = async (ref) => { const recipe = store.get(checkRef(ref)); return { recipe, mesh: await compile(recipe) }; };
  return {
    async mint_solid({ recipe }) { const m = store.mint(recipe); return { ref: m.ref, title: m.recipe.title }; },
    async list_solids() { return { solids: store.list() }; },
    async get_solid({ ref }) { return store.get(checkRef(ref)); },
    async update_solid({ ref, ...patch }) { return { ref, recipe: store.update(checkRef(ref), patch) }; },
    async export_solid({ ref, format }) {
      const emit = FORMATS[format]; if (!emit) throw new Error(`unknown format: ${format} (use ${Object.keys(FORMATS).join('|')})`);
      checkRef(ref);
      const recipe = store.get(ref);
      const data = format === 'json' || format === 'scad' ? emit(recipe) : emit(recipe, (await compile(recipe)));
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, `${ref}.${format}`);
      writeFileSync(path, buf);
      return { path, format, sizeBytes: buf.length, sha256: sha(buf), ref };
    },
    async render_turntable({ ref, frames = 8, size = 256, elevation_deg = 25 }) {
      if (!Number.isInteger(frames) || frames < 3 || frames > 36) throw new Error('frames must be an integer 3..36');
      if (!Number.isInteger(size) || size < 32 || size > 1024) throw new Error('size must be an integer 32..1024');
      const { mesh } = await load(ref);
      const pngs = renderTurntable(mesh, { frames, size, elevation: (elevation_deg * Math.PI) / 180 });
      const dir = join(outDir, `${ref}-turntable`); mkdirSync(dir, { recursive: true });
      const paths = pngs.map((b, i) => { const p = join(dir, `frame-${String(i).padStart(2, '0')}.png`); writeFileSync(p, b); return p; });
      return { ref, frames: paths.length, size, paths };
    },
    async render_shot({ ref, angle_deg = 0, elevation_deg = 26, size = 512, background = STUDIO_BG }) {
      if (!Number.isFinite(angle_deg)) throw new Error('angle_deg must be a number');
      if (!Number.isFinite(elevation_deg) || Math.abs(elevation_deg) > 89) throw new Error('elevation_deg must be within -89..89');
      if (!Number.isInteger(size) || size < 32 || size > 1024) throw new Error('size must be an integer 32..1024');
      const { mesh } = await load(ref);
      const rad = Math.PI / 180;
      const png = encodePNG(size, size, renderFrame(mesh, { size, angle: angle_deg * rad, elevation: elevation_deg * rad, background: parseBackground(background) }));
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, `${ref}-shot-${angle_deg}-${elevation_deg}.png`);
      writeFileSync(path, png);
      return { path, size };
    },
    async render_standard({ ref, size = 1024, background = STUDIO_BG }) {
      if (!Number.isInteger(size) || size < 64 || size > 2048) throw new Error('size must be an integer 64..2048');
      const bg = parseBackground(background);
      const { mesh } = await load(ref);
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, `${ref}-standard.png`);
      writeFileSync(path, renderStandard(mesh, { size, background: bg }));
      const d = (k) => `angle_deg=${STANDARD_PANELS[k].angle_deg} elevation_deg=${STANDARD_PANELS[k].elevation_deg}`;
      return { path, size, panels: { front: `front-on ${d('front')}`, high: `angled-high ${d('high')}` } };
    },
    async measure_solid({ ref }) { return measure((await load(ref)).mesh); },
  };
}

export async function callTool(handlers, name, args) {
  if (!Object.hasOwn(handlers, name)) throw new Error(`unknown tool: ${name}`);
  return handlers[name](args ?? {});
}

export function serve({ input = process.stdin, output = process.stdout, handlers = makeHandlers() } = {}) {
  const send = (m) => output.write(JSON.stringify(m) + '\n');
  const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const rl = createInterface({ input });
  let chain = Promise.resolve(); // handle messages in order (WASM compiles are heavy; keep it simple)
  rl.on('line', (line) => { if (line.trim()) chain = chain.then(() => handle(line)).catch(() => {}); });
  async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return err(null, -32700, 'parse error'); }
    const { id, method, params } = msg;
    const isNote = id === undefined;
    if (typeof method !== 'string') return isNote ? undefined : err(id, -32600, 'invalid request');
    switch (method) {
      case 'initialize': return ok(id, { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'scadify', version: VERSION } });
      case 'ping': return ok(id, {});
      case 'tools/list': return ok(id, { tools: TOOLS });
      case 'tools/call':
        try {
          const result = await callTool(handlers, params?.name, params?.arguments);
          return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (e) {
          return ok(id, { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true });
        }
      default: if (!isNote) return err(id, -32601, `method not found: ${method}`);
    }
  }
  return new Promise((res) => rl.on('close', () => chain.then(res)));
}
