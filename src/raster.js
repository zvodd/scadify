// Software turntable rasterizer + PNG encoder. Orthographic, z-buffer, flat lambert, flat studio background (or transparent), 2x2 SSAA.
import { deflateSync } from 'node:zlib';
import { crc32 } from './emitters/zip.js';

export function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePNGHeader(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), sig: buf.subarray(0, 8).toString('hex') }; }

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export const STUDIO_BG = '#0C1019'; // flat studio background, measured from the reference image: rgb(12,16,25)

/** Normalize a background option: hex '#rrggbb' -> hex; null / 'transparent' -> null (alpha 0 where nothing is drawn). */
export function parseBackground(bg) {
  if (bg === null || bg === 'transparent') return null;
  if (typeof bg === 'string' && /^#[0-9a-fA-F]{6}$/.test(bg)) return bg;
  throw new Error('background must be a #rrggbb hex string, "transparent" or null');
}

/** Render one frame. angle in radians about +z; elevation in radians. Returns RGBA Buffer (size*size*4).
 *  background: '#rrggbb' (default STUDIO_BG, opaque PNG) or null for a transparent background. */
export function renderFrame(mesh, { size = 256, angle = 0, elevation = 0.45, ssaa = 2, background = STUDIO_BG, zoom = 1 } = {}) {
  const bg = parseBackground(background); const [br, bgc, bb] = bg ? rgb(bg) : [0, 0, 0];
  const S = size * ssaa;
  const color = new Uint8Array(S * S * 4); const depth = new Float32Array(S * S).fill(Infinity);
  // bounds -> center + radius
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.parts) for (let i = 0; i < p.positions.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p.positions[i + a]); hi[a] = Math.max(hi[a], p.positions[i + a]); }
  const c = lo.map((v, i) => (v + hi[i]) / 2);
  const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
  const ca = Math.cos(angle), sa = Math.sin(angle), ce = Math.cos(elevation), se = Math.sin(elevation);
  // world(z-up) -> view: rotate about z by -angle, then tilt about x by elevation; view x right, y up, z toward camera
  const toView = (x, y, z) => {
    const rx = x * ca + y * sa, ry = -x * sa + y * ca;
    return [rx, z * ce + ry * se, z * se - ry * ce]; // camera above, on the -y side looking +y; view z points at the camera
  };
  const scale = ((S * 0.46) / r) * zoom;
  const L = norm([-0.4, -0.5, 0.75]); // key light, view space
  for (const p of mesh.parts) {
    const [pr, pg, pb] = rgb(p.tint); const P = p.positions; const V = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const [vx, vy, vz] = toView(P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2]);
      V[i] = S / 2 + vx * scale; V[i + 1] = S / 2 - vy * scale; V[i + 2] = vz;
    }
    for (let t = 0; t < p.indices.length; t += 3) {
      const a = p.indices[t] * 3, b = p.indices[t + 1] * 3, d = p.indices[t + 2] * 3;
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], vx = V[d] - V[a], vy = V[d + 1] - V[a + 1];
      const area = ux * vy - uy * vx; // screen space (y down): CCW front faces have negative area
      if (area === 0) continue;
      // view-space normal from 3D positions (y up)
      const A = [V[a], -V[a + 1], V[a + 2]], B = [V[b], -V[b + 1], V[b + 2]], D = [V[d], -V[d + 1], V[d + 2]];
      let n = norm(cross(sub(B, A), sub(D, A)));
      if (n[2] < 0) n = [-n[0], -n[1], -n[2]]; // two-sided: light the face we see
      const k = 0.28 + 0.72 * Math.max(0, dot(n, L));
      const cr = Math.min(255, pr * k) | 0, cg = Math.min(255, pg * k) | 0, cb = Math.min(255, pb * k) | 0;
      const minx = Math.max(0, Math.floor(Math.min(V[a], V[b], V[d]))), maxx = Math.min(S - 1, Math.ceil(Math.max(V[a], V[b], V[d])));
      const miny = Math.max(0, Math.floor(Math.min(V[a + 1], V[b + 1], V[d + 1]))), maxy = Math.min(S - 1, Math.ceil(Math.max(V[a + 1], V[b + 1], V[d + 1])));
      const inv = 1 / area;
      for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5 - V[a], py = y + 0.5 - V[a + 1];
        const w1 = (px * vy - py * vx) * inv, w2 = (ux * py - uy * px) * inv, w0 = 1 - w1 - w2;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = -(w0 * V[a + 2] + w1 * V[b + 2] + w2 * V[d + 2]); // smaller = nearer
        const o = y * S + x;
        if (z < depth[o]) { depth[o] = z; color[o * 4] = cr; color[o * 4 + 1] = cg; color[o * 4 + 2] = cb; color[o * 4 + 3] = 255; }
      }
    }
  }
  // downsample (premultiplied average)
  const out = Buffer.alloc(size * size * 4); const n2 = ssaa * ssaa;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (let sy = 0; sy < ssaa; sy++) for (let sx = 0; sx < ssaa; sx++) { const o = ((y * ssaa + sy) * S + x * ssaa + sx) * 4; const al = color[o + 3]; R += color[o] * al; G += color[o + 1] * al; B += color[o + 2] * al; A += al; }
    const o = (y * size + x) * 4;
    if (A) {
      const cov = A / (255 * n2); // geometry coverage of this pixel; the rest is background
      out[o] = Math.round((R / A) * cov + br * (1 - cov)); out[o + 1] = Math.round((G / A) * cov + bgc * (1 - cov)); out[o + 2] = Math.round((B / A) * cov + bb * (1 - cov));
      out[o + 3] = bg ? 255 : Math.round(A / n2);
    } else if (bg) { out[o] = br; out[o + 1] = bgc; out[o + 2] = bb; out[o + 3] = 255; }
  }
  return out;
}

export function renderTurntable(mesh, { frames = 8, size = 256, elevation = 0.45 } = {}) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    const rgba = renderFrame(mesh, { size, elevation, angle: (i / frames) * Math.PI * 2, background: null }); // turntable stays transparent
    out.push(encodePNG(size, size, rgba));
  }
  return out;
}

/** Standard preview: front-on (0 deg, 8 deg up) left, angled-high (30 deg, 32 deg up) right, one square PNG.
 *  Each panel is a square render (zoomed so the model's projected bbox fills it) sized to its half of the canvas, centred vertically. */
export const STANDARD_PANELS = { front: { angle_deg: 0, elevation_deg: 8 }, high: { angle_deg: 30, elevation_deg: 32 } };
/** zoom that makes the model's bbox (all 8 corners, projected from this camera) fill a panel; bbox is symmetric about its centre, so the view stays centred. */
function bboxZoom(mesh, angle, elevation) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.parts) for (let i = 0; i < p.positions.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p.positions[i + a]); hi[a] = Math.max(hi[a], p.positions[i + a]); }
  const hx = (hi[0] - lo[0]) / 2, hy = (hi[1] - lo[1]) / 2, hz = (hi[2] - lo[2]) / 2;
  const r = Math.hypot(hx, hy, hz) || 1; const ca = Math.cos(angle), sa = Math.sin(angle), ce = Math.cos(elevation), se = Math.sin(elevation);
  let ex = 0, ey = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * hx, y = sy * hy, z = sz * hz; const rx = x * ca + y * sa, ry = -x * sa + y * ca;
    ex = Math.max(ex, Math.abs(rx)); ey = Math.max(ey, Math.abs(z * ce + ry * se));
  }
  return r / (Math.max(ex, ey) || r);
}

export function renderStandard(mesh, { size = 1024, background = STUDIO_BG } = {}) {
  const bg = parseBackground(background); const gap = Math.max(2, Math.round(size * 0.02));
  const pw = Math.floor((size - gap) / 2); const x0 = Math.floor((size - (2 * pw + gap)) / 2); const y0 = Math.floor((size - pw) / 2);
  const canvas = Buffer.alloc(size * size * 4);
  if (bg) { const [r, g, b] = rgb(bg); for (let i = 0; i < size * size; i++) { canvas[i * 4] = r; canvas[i * 4 + 1] = g; canvas[i * 4 + 2] = b; canvas[i * 4 + 3] = 255; } }
  [['front', x0], ['high', x0 + pw + gap]].forEach(([k, x]) => {
    const { angle_deg, elevation_deg } = STANDARD_PANELS[k];
    const angle = (angle_deg * Math.PI) / 180, elevation = (elevation_deg * Math.PI) / 180;
    const f = renderFrame(mesh, { size: pw, angle, elevation, background: bg, zoom: bboxZoom(mesh, angle, elevation) });
    for (let row = 0; row < pw; row++) f.copy(canvas, ((y0 + row) * size + x) * 4, row * pw * 4, (row + 1) * pw * 4);
  });
  return encodePNG(size, size, canvas);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(v) { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
