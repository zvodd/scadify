// 3MF (print): one object per part, written in MILLIMETRES (unit="millimeter") whatever the recipe unit, zipped deterministically.
import { zip } from './zip.js';
import { metersPerUnit } from '../recipe.js';
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const f = (x) => +x.toFixed(5);
export function emit3MF(recipe, mesh) {
  const mm = metersPerUnit(recipe) * 1000; // recipe units -> mm
  let objs = '', items = '';
  mesh.parts.forEach((p, i) => {
    const id = i + 1; let v = '', t = '';
    for (let j = 0; j < p.positions.length; j += 3) v += `<vertex x="${f(p.positions[j] * mm)}" y="${f(p.positions[j + 1] * mm)}" z="${f(p.positions[j + 2] * mm)}"/>`;
    for (let k = 0; k < p.indices.length; k += 3) t += `<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"/>`;
    objs += `<object id="${id}" name="${esc(p.name)}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
    items += `<item objectid="${id}"/>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">${esc(recipe.title)}</metadata><metadata name="Application">scadify</metadata><resources>${objs}</resources><build>${items}</build></model>`;
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: model },
  ]);
}
