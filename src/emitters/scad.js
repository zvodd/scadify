// The program itself, assembled: params, program, each part as a tinted block. For csg recipes this is the transpile.
import { toScadParts, scadValue } from '../recipe.js';
import { partTint } from '../recipe.js';

export function emitSCAD(recipe) {
  const { program, partCode } = toScadParts(recipe);
  const params = Object.entries({ seed: recipe.seed, ...recipe.params }).map(([k, v]) => `${k} = ${scadValue(v)};`).join('\n');
  const blocks = Object.keys(recipe.parts).map((n) => `// part: ${n}\ncolor("${partTint(recipe, n)}") {\n${partCode[n]}\n}`).join('\n\n');
  return `// scadify: ${recipe.title} (units: ${recipe.units})\n${program}\n\n// recipe params (override program defaults)\n${params}\n\n${blocks}\n`;
}
