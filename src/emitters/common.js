// Shared by the interchange emitters (glb, usd): meters normalization + part naming.
import { metersPerUnit } from '../recipe.js';

/** Recipe-unit positions -> metres (Float32Array). mm*0.001, cm*0.01, dm*0.1, m*1. Interchange formats are always 1 unit = 1 m. */
export function positionsInMeters(positions, recipe) {
  const f = metersPerUnit(recipe);
  return f === 1 ? positions : Float32Array.from(positions, (v) => v * f);
}

/** Names for exported nodes/prims: the part names themselves; a numeric suffix (_2, _3, ...) only when a name repeats
 *  or hits a reserved sibling name. */
export function uniqueNames(names, reserved = []) {
  const used = new Set(reserved); const out = [];
  for (const n of names) {
    let u = n; for (let k = 2; used.has(u); k++) u = `${n}_${k}`;
    used.add(u); out.push(u);
  }
  return out;
}
