// Plain JSON filesystem store: one file per ref. No DB.
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, recipeHash, slug } from './recipe.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const defaultStoreDir = () => resolve(process.env.SCADIFY_STORE || join(ROOT, 'store'));
export const defaultOutDir = () => resolve(process.env.SCADIFY_OUT || join(ROOT, 'out'));

export function checkRef(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw new Error(`invalid ref: ${JSON.stringify(ref)}`);
  return ref;
}

export class Store {
  constructor(dir = defaultStoreDir()) { this.dir = dir; }
  file(ref) { return join(this.dir, `${checkRef(ref)}.json`); }
  has(ref) { return existsSync(this.file(ref)); }

  /** Store a recipe. ref = slug(title)-<8 hex of content hash>; minting identical content is idempotent. */
  mint(input) {
    const recipe = normalize(input);
    const ref = `${slug(recipe.title)}-${recipeHash(recipe).slice(0, 8)}`;
    this.#write(ref, recipe);
    return { ref, recipe };
  }

  get(ref) {
    const f = this.file(ref);
    if (!existsSync(f)) throw new Error(`no such solid: ${ref}`);
    return JSON.parse(readFileSync(f, 'utf8'));
  }

  /** Edit in place (ref is stable): params merge, program/parts/tree/title/seed/tints replace. */
  update(ref, patch) {
    const cur = this.get(ref);
    const next = { ...cur };
    for (const k of ['title', 'program', 'parts', 'seed', 'tints']) if (patch[k] !== undefined) next[k] = patch[k];
    if (patch.tree !== undefined) next.parts = { solid: patch.tree };
    if (patch.params !== undefined) next.params = { ...cur.params, ...patch.params };
    const recipe = normalize(next);
    this.#write(ref, recipe);
    return recipe;
  }

  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
      const ref = f.slice(0, -5);
      try { const r = this.get(ref); return { ref, title: r.title, kind: r.kind }; } catch { return { ref, title: null, kind: null }; }
    });
  }

  #write(ref, recipe) {
    mkdirSync(this.dir, { recursive: true });
    const f = this.file(ref);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(recipe, null, 2) + '\n');
    renameSync(tmp, f);
  }
}
