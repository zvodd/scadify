import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { normalize, RecipeError } from '../src/recipe.js';
import { compile, measure } from '../src/engine.js';
import { makeHandlers, serve } from '../src/mcp.js';
import { unzip } from '../src/emitters/zip.js';
import { uniqueNames } from '../src/emitters/common.js';
import { decodePNGHeader } from '../src/raster.js';
import { PassThrough } from 'node:stream';
import { inflateSync } from 'node:zlib';

// decode a PNG written by src/raster.js (8-bit RGBA, filter 0) -> { w, h, px: Buffer }
function decodeRGBA(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20); let p = 8; const idat = [];
  while (p < buf.length) { const n = buf.readUInt32BE(p); if (buf.toString('latin1', p + 4, p + 8) === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + n)); p += 12 + n; }
  const raw = inflateSync(Buffer.concat(idat)); const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return { w, h, px };
}

const here = dirname(fileURLToPath(import.meta.url));
// Inline fixture: a 40x30x12 open tray (blue shell) with four standoffs (gold). Fully deterministic, no randomness.
const example = {
  kind: 'scad', title: 'demo-tray', seed: 7, // units omitted -> default 'dm'
  program: 'wall_h = 12;\nmodule tray() { difference() { cube([40, 30, wall_h]); translate([2, 2, 2]) cube([36, 26, wall_h]); } }\nmodule standoffs() { for (x = [5, 33], y = [6, 20]) translate([x, y, 1.99]) cylinder(d = 5, h = 4, $fn = 24); }',
  parts: { tray: 'tray();', standoffs: 'standoffs();' },
  params: { wall_h: 12 },
  tints: { tray: '#3f6fb0', standoffs: '#c9a227' },
};
const tmp = mkdtempSync(join(tmpdir(), 'scadify-'));
const store = new Store(join(tmp, 'store'));
const h = makeHandlers({ store, outDir: join(tmp, 'out') });
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

test('recipe validation', () => {
  assert.throws(() => normalize({ kind: 'nope' }), RecipeError);
  assert.throws(() => normalize({ kind: 'scad' }), /program/);
  assert.throws(() => normalize({ kind: 'scad', program: '', parts: { 'bad name': 'x' } }), /part name/);
  assert.throws(() => normalize({ kind: 'csg', tree: { op: 'bogus' } }), /unknown csg op/);
  assert.throws(() => normalize({ kind: 'scad', program: '', params: { 'x;y': 1 } }), /param name/);
  const base = { kind: 'scad', program: '', parts: { a: 'cube(1);' } };
  assert.equal(normalize(base).units, 'dm', 'default unit is architectural');
  for (const u of ['mm', 'cm', 'dm', 'm']) assert.equal(normalize({ ...base, units: u }).units, u);
  for (const u of ['km', 'ft', '', 5]) assert.throws(() => normalize({ ...base, units: u }), /units must be one of/);
});

test('part call without a trailing ";" is terminated (OpenSCAD EOF parse guard)', () => {
  const base = { kind: 'scad', program: 'module b() { cube([1,1,1]); }' };
  const r = normalize({ ...base, parts: { b: 'b()' } });
  assert.equal(r.parts.b, 'b();');                 // bare call gets the semicolon
  assert.equal(normalize({ ...base, parts: { b: 'b();' } }).parts.b, 'b();');  // already-terminated unchanged
  assert.equal(normalize({ ...base, parts: { b: '' } }).parts.b, ';');        // empty -> statement terminator
});

test('store: mint is idempotent, update keeps ref, bad refs rejected', async () => {
  const a = await h.mint_solid({ recipe: example });
  const b = await h.mint_solid({ recipe: example });
  assert.equal(a.ref, b.ref);
  assert.equal((await h.list_solids()).solids.length, 1);
  await assert.rejects(h.get_solid({ ref: '../etc/passwd' }), /invalid ref/);
  const u = await h.update_solid({ ref: a.ref, params: { wall_h: 20 } });
  assert.equal(u.recipe.params.wall_h, 20);
  assert.equal(u.ref, a.ref);
  await h.update_solid({ ref: a.ref, params: { wall_h: 12 } });
});

test('determinism: two compiles give the same checksum; params change geometry', async () => {
  const r = normalize(example);
  const m1 = await compile(r);
  const m2 = await compile({ ...r, title: 'again' }); // different hash -> uncached recompile
  assert.equal(m1.checksum, m2.checksum);
  const tall = await compile(normalize({ ...example, params: { wall_h: 20 } }));
  assert.notEqual(tall.checksum, m1.checksum);
  const s = measure(m1);
  near(s.size[0], 40); near(s.size[1], 30); near(s.size[2], 12);
  near(s.parts.find((p) => p.name === 'tray').volume_mm3, 5040, 0.01); // 40*30*12 - 36*26*10
  assert.equal(s.parts.length, 2);
  assert.ok(s.volume_mm3 > 0);
});

test('seed reaches a program that never declares it (rands(..., seed))', async () => {
  const mk = (seed) => normalize({ kind: 'scad', title: 'seeded', seed, program: 'R = rands(0, 1, 4, seed);', parts: { a: 'cube([5, 5, 2 + 10 * R[0]]);' } });
  const a = measure(await compile(mk(1))), b = measure(await compile(mk(2)));
  assert.ok(a.size[2] < 12 && b.size[2] < 12, 'undef seed would extrude to the 100 mm default');
  assert.notEqual(a.checksum, b.checksum);
});

test('units: glb/usd are written in metres (metersPerUnit 1); stl/3mf in millimetres; raw mesh coords stay in recipe units', async () => {
  const cube = (units) => ({ kind: 'csg', title: `cube-${units}`, units, tree: { op: 'cube', size: [10, 20, 30] } });
  const want = { mm: [0.001, 1], cm: [0.01, 10], dm: [0.1, 100], m: [1, 1000] }; // [metersPerUnit, mm per unit]
  for (const [units, [mpu, toMm]] of Object.entries(want)) {
    const { ref } = await h.mint_solid({ recipe: cube(units) });
    assert.equal((await h.measure_solid({ ref })).size[2], 30, 'mesh coords are in recipe units');
    const glb = readFileSync((await h.export_solid({ ref, format: 'glb' })).path);
    const g = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
    assert.equal(g.asset.extras.units, 'm'); assert.equal(g.asset.extras.metersPerUnit, 1); assert.equal(g.asset.extras.sourceUnits, units);
    near(g.accessors[0].max[2], 30 * mpu, 1e-5); near(g.accessors[0].max[0] - g.accessors[0].min[0], 10 * mpu, 1e-5); // metres
    const usda = readFileSync((await h.export_solid({ ref, format: 'usda' })).path, 'utf8');
    assert.match(usda, /metersPerUnit = 1\n/);
    const ext = usda.match(/float3\[\] extent = \[\([^)]*\), \(([^)]*)\)\]/)[1].split(',').map(Number); near(ext[2], 30 * mpu, 1e-5);
    const stl = readFileSync((await h.export_solid({ ref, format: 'stl' })).path); let zmax = -Infinity;
    for (let t = 0; t < stl.readUInt32LE(80); t++) for (let v = 0; v < 3; v++) zmax = Math.max(zmax, stl.readFloatLE(84 + t * 50 + 12 + v * 12 + 8));
    near(zmax, 30 * toMm, 1e-2);
    const m3 = unzip(readFileSync((await h.export_solid({ ref, format: '3mf' })).path))['3D/3dmodel.model'].data.toString();
    assert.match(m3, /unit="millimeter"/); near(Math.max(...[...m3.matchAll(/ z="([-\d.]+)"/g)].map((m) => +m[1])), 30 * toMm, 1e-2);
    assert.match(readFileSync((await h.export_solid({ ref, format: 'scad' })).path, 'utf8'), new RegExp(`units: ${units}\\)`));
  }
});

test('part naming: names are the part names; a numeric suffix only on collision', () => {
  assert.deepEqual(uniqueNames(['shell', 'dome', 'dome_coral']), ['shell', 'dome', 'dome_coral']);
  assert.deepEqual(uniqueNames(['a', 'a', 'a', 'b']), ['a', 'a_2', 'a_3', 'b']);
  assert.deepEqual(uniqueNames(['Materials', 'x'], ['Materials']), ['Materials_2', 'x']);
});

test('csg compiles via manifold and transpiles to scad; param refs work', async () => {
  const recipe = { kind: 'csg', title: 'block', params: { w: 30 }, tree: { op: 'difference', children: [
    { op: 'cube', size: [{ param: 'w' }, 20, 10] }, { op: 'translate', v: [15, 10, -1], children: [{ op: 'cylinder', h: 12, r: 4, fn: 32 }] }] } };
  const { ref } = await h.mint_solid({ recipe });
  const s = await h.measure_solid({ ref });
  near(s.size[0], 30); near(s.size[2], 10);
  const full = 30 * 20 * 10; assert.ok(s.volume_mm3 < full && s.volume_mm3 > full - 12 * Math.PI * 16 - 5);
  const scad = readFileSync((await h.export_solid({ ref, format: 'scad' })).path, 'utf8');
  assert.match(scad, /difference\(\)/); assert.match(scad, /w = 30;/);
});

let ref;
test('every format: export, re-read, assert structure', async () => {
  ({ ref } = await h.mint_solid({ recipe: example }));
  const out = {};
  for (const format of ['glb', 'gltf', 'stl', '3mf', 'usdz', 'usda', 'scad', 'json']) {
    out[format] = await h.export_solid({ ref, format });
    assert.ok(existsSync(out[format].path)); assert.ok(out[format].sizeBytes > 0); assert.equal(out[format].sha256.length, 64);
  }
  // GLB: 2 parts, bbox, flat tree, no cameras/lights/ground/skins/animations
  const glb = readFileSync(out.glb.path);
  assert.equal(glb.readUInt32LE(0), 0x46546c67); assert.equal(glb.readUInt32LE(8), glb.length);
  const jl = glb.readUInt32LE(12); const g = JSON.parse(glb.toString('utf8', 20, 20 + jl));
  assert.equal(g.nodes.length, 2); assert.equal(g.meshes.length, 2); assert.deepEqual(g.nodes.map((n) => n.name).sort(), ['standoffs', 'tray']);
  for (const n of g.nodes) { assert.ok(!n.children && !n.camera && !n.matrix && !n.translation && !n.skin); }
  for (const k of ['cameras', 'skins', 'animations', 'extensions', 'extensionsUsed']) assert.equal(g[k], undefined, k);
  assert.equal(g.asset.extras.units, 'm'); assert.equal(g.asset.extras.metersPerUnit, 1); assert.equal(g.asset.extras.sourceUnits, 'dm'); assert.equal(g.asset.extras.upAxis, 'Z');
  const ti = g.nodes.findIndex((n) => n.name === 'tray'); const tray = g.accessors[g.meshes[g.nodes[ti].mesh].primitives[0].attributes.POSITION]; near(tray.max[0] - tray.min[0], 4); near(tray.max[2] - tray.min[2], 1.2); // 40 x 12 dm in metres
  assert.deepEqual(g.materials[g.meshes[g.nodes[ti].mesh].primitives[0].material].pbrMetallicRoughness.baseColorFactor.slice(0, 3).map((x) => +x.toFixed(2)), [0.25, 0.44, 0.69]);
  const gltf = JSON.parse(readFileSync(out.gltf.path, 'utf8')); assert.equal(gltf.nodes.length, 2);
  // STL: binary, count matches, bbox
  const stl = readFileSync(out.stl.path); const n = stl.readUInt32LE(80); assert.equal(stl.length, 84 + n * 50);
  let max = -Infinity; for (let t = 0; t < n; t++) for (let v = 0; v < 3; v++) max = Math.max(max, stl.readFloatLE(84 + t * 50 + 12 + v * 12 + 8));
  near(max, 1200); // 12 dm written in millimetres
  // 3MF
  const z = unzip(readFileSync(out['3mf'].path)); const model = z['3D/3dmodel.model'].data.toString();
  assert.match(model, /unit="millimeter"/); near(Math.max(...[...model.matchAll(/ x="([-\d.]+)"/g)].map((m) => +m[1])), 4000); // 40 dm -> 4000 mm
   assert.equal((model.match(/<object /g) || []).length, 2); assert.ok(z['[Content_Types].xml'] && z['_rels/.rels']);
  // USDZ: one aligned usda, z-up, metres; USDA same text
  const uz = unzip(readFileSync(out.usdz.path)); const names = Object.keys(uz); assert.equal(names.length, 1);
  assert.equal(uz[names[0]].offset % 64, 0);
  const usda = uz[names[0]].data.toString(); assert.equal(usda, readFileSync(out.usda.path, 'utf8'));
  assert.match(usda, /upAxis = "Z"/); assert.match(usda, /metersPerUnit = 1\n/); assert.equal((usda.match(/def Mesh /g) || []).length, 2);
  // prims are named after the parts, never generic
  assert.match(usda, /def Xform "tray"\n\s*\{\n\s*def Mesh "tray"/); assert.match(usda, /def Xform "standoffs"\n\s*\{\n\s*def Mesh "standoffs"/);
  assert.ok(!/def Mesh "mesh"/i.test(usda));
  for (const k of ['nodes', 'meshes', 'materials']) assert.deepEqual(g[k].map((x) => x.name).sort(), ['standoffs', 'tray'], `glb ${k} named after parts`);
  assert.ok(!/Camera|Light/.test(usda));
  assert.match(readFileSync(out.scad.path, 'utf8'), /module tray/);
  assert.equal(JSON.parse(readFileSync(out.json.path, 'utf8')).title, 'demo-tray');
});

test('export is byte-for-byte deterministic (second export, fresh handlers)', async () => {
  const h2 = makeHandlers({ store, outDir: join(tmp, 'out2') });
  for (const format of ['glb', 'stl', '3mf', 'usdz']) {
    const a = await h.export_solid({ ref, format }); const b = await h2.export_solid({ ref, format });
    assert.equal(a.sha256, b.sha256, format);
  }
});

test('turntable: N valid PNG frames that differ per angle', async () => {
  const r = await h.render_turntable({ ref, frames: 4, size: 96 });
  assert.equal(r.paths.length, 4);
  const sums = new Set();
  for (const p of r.paths) {
    const b = readFileSync(p); const d = decodePNGHeader(b);
    assert.equal(d.sig, '89504e470d0a1a0a'); assert.equal(d.w, 96); assert.equal(d.h, 96); sums.add(b.toString('base64'));
  }
  assert.equal(sums.size, 4, 'frames differ per angle');
  assert.equal(decodeRGBA(readFileSync(r.paths[0])).px[3], 0, 'turntable corner stays transparent');
  await assert.rejects(h.render_turntable({ ref, frames: 2 }), /3\.\.36/);
});

test('render_shot: exactly one valid PNG at a chosen angle, differing by angle', async () => {
  const a = await h.render_shot({ ref, angle_deg: 30, elevation_deg: 30, size: 96 });
  assert.equal(a.size, 96); assert.match(a.path, /\.png$/);
  const b = readFileSync(a.path); const d = decodePNGHeader(b);
  assert.equal(d.sig, '89504e470d0a1a0a'); assert.equal(d.w, 96); assert.equal(d.h, 96);
  const c = await h.render_shot({ ref, angle_deg: 120, elevation_deg: 30, size: 96 });
  assert.notEqual(readFileSync(c.path).toString('base64'), b.toString('base64'));
  await assert.rejects(h.render_shot({ ref, elevation_deg: 95 }), /elevation/);
});

test('background: shots are opaque studio #0C1019 by default; transparent on request; render_standard is opaque with two distinct halves', async () => {
  const bgAt = (img, x, y) => [...img.px.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4)];
  const shot = decodeRGBA(readFileSync((await h.render_shot({ ref, angle_deg: 30, elevation_deg: 30, size: 96, background: '#0C1019' })).path));
  for (let i = 3; i < shot.px.length; i += 4) assert.equal(shot.px[i], 255, 'every pixel opaque');
  assert.deepEqual(bgAt(shot, 0, 0), [12, 16, 25, 255]);
  const dflt = decodeRGBA(readFileSync((await h.render_shot({ ref, angle_deg: 30, elevation_deg: 30, size: 96 })).path));
  assert.deepEqual(dflt.px, shot.px, 'default background is #0C1019');
  const clear = decodeRGBA(readFileSync((await h.render_shot({ ref, angle_deg: 30, elevation_deg: 30, size: 96, background: 'transparent' })).path));
  assert.equal(clear.px[3], 0, 'transparent corner');
  await assert.rejects(h.render_shot({ ref, background: 'red' }), /background/);

  const r = await h.render_standard({ ref, size: 256 });
  assert.equal(r.size, 256); assert.ok(r.panels.front.includes('angle_deg=0') && r.panels.high.includes('angle_deg=30'));
  const img = decodeRGBA(readFileSync(r.path)); assert.equal(img.w, 256); assert.equal(img.h, 256);
  for (let i = 3; i < img.px.length; i += 4) assert.equal(img.px[i], 255, 'composite opaque');
  assert.deepEqual(bgAt(img, 0, 0), [12, 16, 25, 255]);
  const half = 128; const left = Buffer.alloc(half * 256 * 4), right = Buffer.alloc(half * 256 * 4);
  for (let y = 0; y < 256; y++) { img.px.copy(left, y * half * 4, y * 256 * 4, (y * 256 + half) * 4); img.px.copy(right, y * half * 4, (y * 256 + half) * 4, (y * 256 + 256) * 4); }
  assert.ok(!left.equals(right), 'halves differ');
  const nonBg = (b) => { let n = 0; for (let i = 0; i < b.length; i += 4) if (b[i] !== 12 || b[i + 1] !== 16 || b[i + 2] !== 25) n++; return n; };
  assert.ok(nonBg(left) > 200 && nonBg(right) > 200, 'both halves contain the model');
});

test('mcp stdio: initialize, tools/list, tools/call, errors', async () => {
  const input = new PassThrough(); const output = new PassThrough(); const lines = [];
  output.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  const done = serve({ input, output, handlers: h });
  const send = (m) => input.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'measure_solid', arguments: { ref } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  send({ jsonrpc: '2.0', id: 5, method: 'bogus' });
  input.end(); await done;
  const by = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(lines.length, 5); // the notification gets no reply
  assert.equal(by[1].result.serverInfo.name, 'scadify');
  assert.deepEqual(by[2].result.tools.map((t) => t.name), ['mint_solid', 'list_solids', 'get_solid', 'update_solid', 'export_solid', 'render_turntable', 'render_shot', 'render_standard', 'measure_solid']);
  near(by[3].result.structuredContent.size[2], 12);
  assert.equal(by[4].result.isError, true); assert.equal(by[5].error.code, -32601);
});

test('bin starts and answers initialize', () => {
  const r = spawnSync('node', [join(here, '../src/scadify-cli.mjs')], { input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', encoding: 'utf8', timeout: 20000 });
  assert.equal(JSON.parse(r.stdout.split('\n')[0]).result.serverInfo.name, 'scadify');
});
