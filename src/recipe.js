// Recipe parse / validate / normalize / csg->scad transpile. Pure, no I/O.
import { createHash } from 'node:crypto';

const KINDS = ['scad', 'csg'];
/** Recipe length unit -> metres per unit. Coordinates in a recipe are in this unit; the default is architectural (1 unit = 10 cm). */
export const UNIT = { mm: 0.001, cm: 0.01, dm: 0.1, m: 1 };
export const DEFAULT_UNITS = 'dm';
export const metersPerUnit = (recipe) => UNIT[recipe.units];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAM_RE = /^\$?[A-Za-z_][A-Za-z0-9_]*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const PALETTE = ['#c8ccd0', '#d9822b', '#3f8fd2', '#5fae5f', '#c0504d', '#8e6fc1', '#d8c24a', '#4bb3a8'];
const MAX_NODES = 2000;
const MAX_DEPTH = 64;

export class RecipeError extends Error {}
const fail = (m) => { throw new RecipeError(m); };

export function slug(s) {
  return String(s || 'solid').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'solid';
}

function checkParams(params) {
  if (params === undefined) return {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('params must be an object');
  const out = {};
  for (const k of Object.keys(params).sort()) {
    if (!PARAM_RE.test(k)) fail(`bad param name: ${k}`);
    const v = params[k];
    const ok = (x) => typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
    if (!(ok(v) || (Array.isArray(v) && v.every((e) => ok(e) || (Array.isArray(e) && e.every(ok)))))) fail(`param ${k}: unsupported value`);
    out[k] = v;
  }
  return out;
}

/** Validate + normalize into a canonical recipe (sorted keys for stable bytes). Throws RecipeError. */
export function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('recipe must be an object');
  const kind = input.kind ?? 'scad';
  if (!KINDS.includes(kind)) fail(`kind must be one of ${KINDS.join('|')}`);
  const units = input.units ?? DEFAULT_UNITS;
  if (typeof units !== 'string' || !Object.hasOwn(UNIT, units)) fail(`units must be one of ${Object.keys(UNIT).join('|')}`);
  const seed = input.seed ?? 0;
  if (!Number.isInteger(seed)) fail('seed must be an integer');
  const title = String(input.title ?? 'untitled').slice(0, 120);
  const r = { kind, title, units, seed, params: checkParams(input.params) };

  let parts = input.parts;
  if (kind === 'scad') {
    if (typeof input.program !== 'string') fail('kind "scad" needs a string "program"');
    r.program = input.program;
    if (parts === undefined) parts = { solid: '' }; // program's own top-level geometry
    if (!parts || typeof parts !== 'object' || Array.isArray(parts)) fail('parts must be an object name -> scad statement');
    r.parts = {};
    for (const k of Object.keys(parts)) {
      if (!NAME_RE.test(k)) fail(`bad part name: ${k}`);
      if (typeof parts[k] !== 'string') fail(`part ${k}: must be a string of scad`);
      r.parts[k] = terminate(parts[k]);
    }
  } else {
    if (parts === undefined && input.tree) parts = { solid: input.tree };
    if (!parts || typeof parts !== 'object' || Array.isArray(parts)) fail('kind "csg" needs "tree" or "parts" (name -> node)');
    r.parts = {};
    const budget = { n: 0 };
    for (const k of Object.keys(parts)) {
      if (!NAME_RE.test(k)) fail(`bad part name: ${k}`);
      checkNode(parts[k], 0, budget);
      r.parts[k] = parts[k];
    }
  }
  if (!Object.keys(r.parts).length) fail('recipe needs at least one part');
  if (input.tints !== undefined) {
    if (!input.tints || typeof input.tints !== 'object') fail('tints must be an object');
    r.tints = {};
    for (const k of Object.keys(input.tints)) {
      if (!(k in r.parts)) fail(`tint for unknown part: ${k}`);
      if (!HEX_RE.test(input.tints[k])) fail(`tint ${k}: must be #rrggbb`);
      r.tints[k] = input.tints[k].toLowerCase();
    }
  }
  return sortKeys(r);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export const canonical = (recipe) => JSON.stringify(sortKeys(recipe));

// A part statement may be authored without its closing `;` (e.g. `"shell()"`), which OpenSCAD
// reads as an unterminated statement -> a cryptic "Parser error: syntax error ... line N+1" at EOF.
// Normalize so every part string is a well-formed statement (ends with `;`) or block (ends with `}`).
const terminate = (s) => {
  const t = s.trimEnd();
  return /[;}]$/.test(t) ? t : t + ';';
};

export const recipeHash = (recipe) => createHash('sha256').update(canonical(recipe)).digest('hex');

export function partTint(recipe, name) {
  if (recipe.tints?.[name]) return recipe.tints[name];
  return PALETTE[Object.keys(recipe.parts).indexOf(name) % PALETTE.length];
}

// ---- csg ------------------------------------------------------------------
const PRIMS = { cube: ['size', 'center'], cylinder: ['h', 'r', 'r1', 'r2', 'd', 'center', 'fn'], sphere: ['r', 'd', 'fn'] };
const XFORMS = { translate: 'v', rotate: 'a', scale: 'v', mirror: 'v' };
const BOOLS = ['union', 'difference', 'intersection', 'hull'];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isRef = (x) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 1 && PARAM_RE.test(x.param ?? '');
const isScalar = (x) => isNum(x) || isRef(x);
const isVec = (x) => Array.isArray(x) && (x.length === 3 || x.length === 2) && x.every(isScalar);

function checkNode(n, depth, budget) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) fail('csg node must be an object');
  if (++budget.n > MAX_NODES) fail('csg tree too large');
  if (depth > MAX_DEPTH) fail('csg tree too deep');
  const op = n.op;
  if (op in PRIMS) {
    for (const k of Object.keys(n)) if (k !== 'op' && !PRIMS[op].includes(k)) fail(`${op}: unknown field ${k}`);
    if (op === 'cube' && !(isScalar(n.size) || isVec(n.size))) fail('cube.size must be a number or [x,y,z]');
    if (op === 'cylinder' && !isScalar(n.h)) fail('cylinder.h required');
    if (op === 'cylinder' && !['r', 'd', 'r1'].some((k) => n[k] !== undefined)) fail('cylinder needs r, d or r1/r2');
    if (op === 'sphere' && n.r === undefined && n.d === undefined) fail('sphere needs r or d');
    for (const k of ['h', 'r', 'r1', 'r2', 'd', 'fn']) if (n[k] !== undefined && !isScalar(n[k])) fail(`${op}.${k} must be a number`);
    if (n.center !== undefined && typeof n.center !== 'boolean') fail(`${op}.center must be boolean`);
  } else if (op in XFORMS || BOOLS.includes(op)) {
    if (op in XFORMS && !isVec(n[XFORMS[op]])) fail(`${op}.${XFORMS[op]} must be [x,y,z]`);
    if (!Array.isArray(n.children) || !n.children.length) fail(`${op}.children must be a non-empty array`);
    for (const c of n.children) checkNode(c, depth + 1, budget);
  } else fail(`unknown csg op: ${op}`);
}

const sc = (x) => (isRef(x) ? x.param : String(x));
const vec = (v) => `[${v.map(sc).join(', ')}]`;

function nodeToScad(n, ind = '') {
  const op = n.op;
  if (op === 'cube') {
    return `${ind}cube(${isScalar(n.size) ? sc(n.size) : vec(n.size)}, center=${!!n.center});`;
  }
  if (op === 'cylinder') {
    const a = [`h=${sc(n.h)}`];
    if (n.r1 !== undefined) a.push(`r1=${sc(n.r1)}`, `r2=${sc(n.r2 ?? 0)}`);
    else if (n.d !== undefined) a.push(`d=${sc(n.d)}`);
    else a.push(`r=${sc(n.r)}`);
    a.push(`center=${!!n.center}`, `$fn=${sc(n.fn ?? 48)}`);
    return `${ind}cylinder(${a.join(', ')});`;
  }
  if (op === 'sphere') return `${ind}sphere(${n.d !== undefined ? `d=${sc(n.d)}` : `r=${sc(n.r)}`}, $fn=${sc(n.fn ?? 48)});`;
  const kids = n.children.map((c) => nodeToScad(c, ind + '  ')).join('\n');
  const head = op in XFORMS ? `${op}(${vec(n[XFORMS[op]])})` : `${op}()`;
  return `${ind}${head} {\n${kids}\n${ind}}`;
}

/** Returns { program, partCode } — the same shape a kind:"scad" recipe has. */
export function toScadParts(recipe) {
  if (recipe.kind === 'scad') return { program: recipe.program, partCode: { ...recipe.parts } };
  const defaults = Object.entries(recipe.params).filter(([k]) => !k.startsWith('$')).map(([k, v]) => `${k} = ${scadValue(v)};`).join('\n');
  const partCode = {};
  for (const [k, node] of Object.entries(recipe.parts)) partCode[k] = nodeToScad(node);
  return { program: defaults, partCode };
}

export function scadValue(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(scadValue).join(', ')}]`;
  return String(v);
}

/** Declarations for seed + params, placed ahead of the program: OpenSCAD's -D only overrides variables the
 *  file already declares ("Ignoring unknown variable"), so an undeclared `seed` would otherwise reach the program as undef. */
export function declareHeader(recipe) {
  const p = { seed: recipe.seed, ...recipe.params };
  return Object.keys(p).sort().map((k) => `${k} = ${scadValue(p[k])};`).join(' ');
}

/** -D arguments: params override program defaults; `seed` is injected unless the recipe sets it. */
export function defineArgs(recipe) {
  const p = { seed: recipe.seed, ...recipe.params };
  return Object.keys(p).sort().flatMap((k) => ['-D', `${k}=${scadValue(p[k])}`]);
}
