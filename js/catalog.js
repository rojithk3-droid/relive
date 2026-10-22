// Everything a player can place. Three kinds:
//   part  - procedural architecture (walls, floors, roofs, stairs, roads...) built from slots; slot 0 takes
//           the player's chosen finish, the other slots are fixed (glass, frames, markings)
//   model - a photo-scanned Poly Haven prop (furniture, lamps, rocks, statues, boats...)
//   tree  - a procedural tree species
// Sizes are metres. A part's origin is the centre of its footprint at its base (y = 0).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPECIES } from './trees.js';

export const CATEGORIES = [
  { id: 'structure', label: 'Walls & floors' },
  { id: 'roof',      label: 'Roofs & stairs' },
  { id: 'ground',    label: 'Roads & ground' },
  { id: 'outdoor',   label: 'Fences & outdoor' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'lighting',  label: 'Lighting' },
  { id: 'decor',     label: 'Decor & vehicles' },
  { id: 'garden',    label: 'Garden (grows!)' },
  { id: 'vehicles',  label: 'Vehicles' },
  { id: 'nature',    label: 'Trees & nature' },
];

// how long a planted crop takes to ripen (server clock, so everyone sees the same stage)
export const GROW_MS = 8 * 60 * 1000;

export const WALL_MATS = ['plaster', 'plaster2', 'greyrender', 'brick', 'plasterbrick', 'sandstone', 'stone', 'stonewall', 'wood', 'wooddark', 'weathered', 'bluewood', 'concrete', 'marble', 'corrugated', 'metal', 'paint'];
export const FLOOR_MATS = ['floorwood', 'parquet', 'laminate', 'tiles', 'marbletile', 'terrazzo', 'concfloor', 'concrete', 'granite', 'stonetiles', 'wood', 'wooddark', 'marble', 'pavers', 'cobble', 'paint'];
export const ROOF_MATS = ['roofclay', 'roofslate', 'roofred', 'roofgrey', 'corrugated', 'wooddark', 'metal', 'concrete'];
export const GROUND_MATS = ['asphalt', 'pavers', 'cobble', 'patterned', 'stonetiles', 'gravel', 'concrete', 'granite', 'wood', 'weathered'];

// ------------------------------------------------------------------ geometry helpers
class Shape {
  constructor() { this.slots = []; }
  add(slot, geo) { (this.slots[slot] ||= []).push(geo); return this; }
  box(slot, w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return this.add(slot, g);
  }
  cyl(slot, r0, r1, h, x = 0, y = 0, z = 0, seg = 12) {
    const g = new THREE.CylinderGeometry(r0, r1, h, seg);
    g.translate(x, y, z);
    return this.add(slot, g);
  }
  build() {
    return this.slots.map((list) => {
      if (!list) return null;
      const clean = list.map((g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k); return n; });
      const m = mergeGeometries(clean, false);
      m.computeBoundingBox(); m.computeBoundingSphere();
      return m;
    });
  }
}

// a wall panel with a rectangular opening; returns boxes in local space (for geometry and colliders)
function wallWithOpening(W, H, T, ow, oy0, oy1) {
  const out = [];
  const side = (W - ow) / 2;
  out.push([side, H, T, -W / 2 + side / 2, H / 2, 0]);
  out.push([side, H, T, W / 2 - side / 2, H / 2, 0]);
  if (oy0 > 0) out.push([ow, oy0, T, 0, oy0 / 2, 0]);
  if (oy1 < H) out.push([ow, H - oy1, T, 0, (H + oy1) / 2, 0]);
  return out;
}
const boxCol = (b) => ({ b: [b[3], b[4], b[5], b[0] / 2, b[1] / 2, b[2] / 2] });

function frameAround(s, slot, ow, oy0, oy1, T, fw = 0.07) {
  s.box(slot, ow + fw * 2, fw, T + 0.04, 0, oy1 + fw / 2, 0);
  s.box(slot, fw, oy1 - oy0, T + 0.04, -ow / 2 - fw / 2, (oy0 + oy1) / 2, 0);
  s.box(slot, fw, oy1 - oy0, T + 0.04, ow / 2 + fw / 2, (oy0 + oy1) / 2, 0);
  if (oy0 > 0) s.box(slot, ow + fw * 2, fw, T + 0.12, 0, oy0 - fw / 2, 0);
}

function gableGeometry(W, H) {
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2, 0); shape.lineTo(W / 2, 0); shape.lineTo(0, H); shape.lineTo(-W / 2, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false });
  g.translate(0, 0, -0.1);
  return g;
}

function hipRoofGeometry(W, D, H, T = 0.18) {
  // four sloped faces meeting at a short ridge, as one closed solid
  const r = Math.min(W, D) / 2;
  const rx = W / 2 - r;
  const v = [
    [-W / 2, 0, -D / 2], [W / 2, 0, -D / 2], [W / 2, 0, D / 2], [-W / 2, 0, D / 2],
    [-rx, H, 0], [rx, H, 0],
  ];
  const faces = [[0, 5, 1], [0, 4, 5], [1, 5, 2], [2, 5, 4], [2, 4, 3], [3, 4, 0], [0, 1, 2], [0, 2, 3]];
  const pos = [];
  for (const f of faces) for (const i of f) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ the catalogue
export const ITEMS = {};
function def(id, o) { ITEMS[id] = { id, ...o }; }

const H = 3, T = 0.2, W = 4;

// ---- walls & floors
def('wall', { label: 'Wall', cat: 'structure', kind: 'part', mat: 'plaster', mats: WALL_MATS, snap: 'edge', size: [W, H, T],
  shape: () => new Shape().box(0, W, H, T, 0, H / 2, 0), cols: [{ b: [0, H / 2, 0, W / 2, H / 2, T / 2] }] });
def('wall_half', { label: 'Half wall', cat: 'structure', kind: 'part', mat: 'plaster', mats: WALL_MATS, snap: 'edge', size: [W, 1.1, T],
  shape: () => new Shape().box(0, W, 1.1, T, 0, 0.55, 0), cols: [{ b: [0, 0.55, 0, W / 2, 0.55, T / 2] }] });
def('wall_short', { label: 'Wall (2 m)', cat: 'structure', kind: 'part', mat: 'plaster', mats: WALL_MATS, snap: 'edge', size: [2, H, T],
  shape: () => new Shape().box(0, 2, H, T, 0, H / 2, 0), cols: [{ b: [0, H / 2, 0, 1, H / 2, T / 2] }] });
{
  const wb = wallWithOpening(W, H, T, 1.4, 0.9, 2.2);
  def('wall_window', { label: 'Wall + window', cat: 'structure', kind: 'part', mat: 'plaster', mats: WALL_MATS, snap: 'edge', size: [W, H, T], slots: [null, 'glass', 'wooddark'],
    shape: () => { const s = new Shape(); for (const b of wb) s.box(0, ...b); s.box(1, 1.4, 1.3, 0.02, 0, 1.55, 0); frameAround(s, 2, 1.4, 0.9, 2.2, T); s.box(2, 0.05, 1.3, 0.06, 0, 1.55, 0); return s; },
    cols: [...wb.map(boxCol), { b: [0, 1.55, 0, 0.7, 0.65, 0.05] }] });
  const wd = wallWithOpening(W, H, T, 1.1, 0, 2.25);
  def('wall_door', { label: 'Wall + doorway', cat: 'structure', kind: 'part', mat: 'plaster', mats: WALL_MATS, snap: 'edge', size: [W, H, T], slots: [null, null, 'wooddark'],
    shape: () => { const s = new Shape(); for (const b of wd) s.box(0, ...b); frameAround(s, 2, 1.1, 0, 2.25, T); return s; }, cols: wd.map(boxCol) });
  const ws = wallWithOpening(W, H, T, 3.2, 0.45, 2.45);
  def('wall_shop', { label: 'Wall + big window', cat: 'structure', kind: 'part', mat: 'plaster', mats: WALL_MATS, snap: 'edge', size: [W, H, T], slots: [null, 'glass', 'metal'],
    shape: () => { const s = new Shape(); for (const b of ws) s.box(0, ...b); s.box(1, 3.2, 2.0, 0.02, 0, 1.45, 0); frameAround(s, 2, 3.2, 0.45, 2.45, T, 0.06); s.box(2, 0.05, 2.0, 0.06, -0.53, 1.45, 0); s.box(2, 0.05, 2.0, 0.06, 0.53, 1.45, 0); return s; },
    cols: [...ws.map(boxCol), { b: [0, 1.45, 0, 1.6, 1.0, 0.05] }] });
  def('glass_wall', { label: 'Glass wall', cat: 'structure', kind: 'part', mat: 'metal', mats: ['metal', 'wooddark', 'paint', 'concrete'], snap: 'edge', size: [W, H, T], slots: [null, 'glass'],
    shape: () => { const s = new Shape(); s.box(1, W, H - 0.1, 0.03, 0, H / 2, 0); for (const x of [-W / 2 + 0.04, 0, W / 2 - 0.04]) s.box(0, 0.08, H, 0.12, x, H / 2, 0); s.box(0, W, 0.08, 0.12, 0, H - 0.04, 0); s.box(0, W, 0.08, 0.12, 0, 0.04, 0); s.box(0, W, 0.05, 0.1, 0, 1.1, 0); return s; },
    cols: [{ b: [0, H / 2, 0, W / 2, H / 2, 0.08] }] });
}
def('gable', { label: 'Gable end', cat: 'structure', kind: 'part', mat: 'plaster', mats: WALL_MATS, snap: 'edge', size: [W, 2, T],
  shape: () => new Shape().add(0, gableGeometry(W, 2)), cols: [{ b: [0, 0.5, 0, 1.2, 0.5, T / 2] }] });
def('floor', { label: 'Floor', cat: 'structure', kind: 'part', mat: 'floorwood', mats: FLOOR_MATS, snap: 'grid4', size: [W, 0.2, W],
  shape: () => new Shape().box(0, W, 0.2, W, 0, 0.1, 0), cols: [{ b: [0, 0.1, 0, W / 2, 0.1, W / 2] }] });
def('floor_small', { label: 'Floor (2×2)', cat: 'structure', kind: 'part', mat: 'floorwood', mats: FLOOR_MATS, snap: 'grid2', size: [2, 0.2, 2],
  shape: () => new Shape().box(0, 2, 0.2, 2, 0, 0.1, 0), cols: [{ b: [0, 0.1, 0, 1, 0.1, 1] }] });
def('foundation', { label: 'Foundation', cat: 'structure', kind: 'part', mat: 'concrete', mats: ['concrete', 'stonewall', 'stone', 'brick', 'sandstone', 'granite'], snap: 'grid4', size: [W, 1.2, W],
  shape: () => new Shape().box(0, W, 1.2, W, 0, -0.2, 0), cols: [{ b: [0, -0.2, 0, W / 2, 0.6, W / 2] }] });
def('pillar', { label: 'Column', cat: 'structure', kind: 'part', mat: 'concrete', mats: [...WALL_MATS], snap: 'grid1', size: [0.36, H, 0.36],
  shape: () => new Shape().box(0, 0.36, H, 0.36, 0, H / 2, 0), cols: [{ b: [0, H / 2, 0, 0.18, H / 2, 0.18] }] });
def('round_column', { label: 'Round column', cat: 'structure', kind: 'part', mat: 'marble', mats: ['marble', 'concrete', 'sandstone', 'stone', 'paint'], snap: 'grid1', size: [0.5, H, 0.5],
  shape: () => new Shape().cyl(0, 0.22, 0.25, H - 0.3, 0, H / 2, 0, 20).box(0, 0.6, 0.15, 0.6, 0, 0.075, 0).box(0, 0.6, 0.15, 0.6, 0, H - 0.075, 0), cols: [{ b: [0, H / 2, 0, 0.25, H / 2, 0.25] }] });
def('beam', { label: 'Beam', cat: 'structure', kind: 'part', mat: 'wooddark', mats: ['wooddark', 'wood', 'metal', 'concrete'], snap: 'edge', size: [W, 0.3, 0.3],
  shape: () => new Shape().box(0, W, 0.3, 0.3, 0, 0.15, 0), cols: [{ b: [0, 0.15, 0, W / 2, 0.15, 0.15] }] });
def('door', { label: 'Door', cat: 'structure', kind: 'part', mat: 'wooddark', mats: ['wooddark', 'wood', 'bluewood', 'weathered', 'metal', 'paint'], snap: 'edge', size: [1.06, 2.22, 0.06], slots: [null, 'metal'],
  // a closed door blocks the doorway; walk up and press E to swing it open (hinge on its local -x edge)
  door: true,
  shape: () => new Shape().box(0, 1.06, 2.22, 0.06, 0, 1.11, 0).box(1, 0.04, 0.04, 0.16, 0.42, 1.05, 0).box(1, 0.12, 0.03, 0.03, 0.38, 1.05, 0.08).box(1, 0.12, 0.03, 0.03, 0.38, 1.05, -0.08), cols: [{ b: [0, 1.11, 0, 0.53, 1.11, 0.05] }] });

// ---- roofs & stairs
def('roof_gable', { label: 'Gable roof', cat: 'roof', kind: 'part', mat: 'roofclay', mats: ROOF_MATS, snap: 'grid4', size: [W, 2, W],
  shape: () => {
    const s = new Shape(), ang = Math.atan2(2, 2), len = Math.hypot(2, 2) + 0.35;
    // rotateX(+a) tips a box's +z end down, so the -z slope turns by -a to rise toward the ridge
    s.box(0, W + 0.3, 0.14, len, 0, 1, -1, -ang); s.box(0, W + 0.3, 0.14, len, 0, 1, 1, ang);
    return s;
  },
  cols: [{ r: [0, 1, -1, W / 2, 1, 1], dir: 1 }, { r: [0, 1, 1, W / 2, 1, 1], dir: -1 }] });
def('roof_hip', { label: 'Hip roof', cat: 'roof', kind: 'part', mat: 'roofslate', mats: ROOF_MATS, snap: 'grid4', size: [W, 2, W],
  shape: () => new Shape().add(0, hipRoofGeometry(W + 0.4, W + 0.4, 2)), cols: [{ b: [0, 0.5, 0, W / 2, 0.5, W / 2] }] });
def('roof_shed', { label: 'Lean-to roof', cat: 'roof', kind: 'part', mat: 'corrugated', mats: ROOF_MATS, snap: 'grid4', size: [W, 1.2, W],
  shape: () => { const ang = Math.atan2(1.2, W); return new Shape().box(0, W + 0.3, 0.12, Math.hypot(W, 1.2) + 0.3, 0, 0.6, 0, ang); },
  cols: [{ r: [0, 0.6, 0, W / 2, 0.6, W / 2], dir: -1 }] });
def('roof_flat', { label: 'Flat roof', cat: 'roof', kind: 'part', mat: 'concrete', mats: ['concrete', 'greyrender', 'plaster', 'concfloor', 'wood', 'tiles'], snap: 'grid4', size: [W, 0.55, W],
  shape: () => new Shape().box(0, W, 0.25, W, 0, 0.125, 0).box(0, W, 0.3, 0.2, 0, 0.4, W / 2 - 0.1).box(0, W, 0.3, 0.2, 0, 0.4, -W / 2 + 0.1),
  cols: [{ b: [0, 0.125, 0, W / 2, 0.125, W / 2] }, { b: [0, 0.4, W / 2 - 0.1, W / 2, 0.15, 0.1] }, { b: [0, 0.4, -W / 2 + 0.1, W / 2, 0.15, 0.1] }] });
def('stairs', { label: 'Stairs', cat: 'roof', kind: 'part', mat: 'wood', mats: ['wood', 'wooddark', 'concrete', 'marble', 'stone', 'metal', 'granite'], snap: 'grid1', size: [1.2, H, 4],
  shape: () => { const s = new Shape(), n = 13; for (let i = 0; i < n; i++) { const h = (i + 1) * (H / n); s.box(0, 1.2, h, 4 / n, 0, h / 2, -2 + (i + 0.5) * (4 / n)); } return s; },
  cols: [{ r: [0, H / 2, 0, 0.6, H / 2, 2], dir: 1 }] });
def('stairs_wide', { label: 'Wide steps', cat: 'roof', kind: 'part', mat: 'stonetiles', mats: ['stonetiles', 'concrete', 'marble', 'granite', 'stone', 'wood'], snap: 'grid1', size: [4, 1.2, 3],
  shape: () => { const s = new Shape(), n = 6; for (let i = 0; i < n; i++) { const h = (i + 1) * (1.2 / n); s.box(0, 4, h, 3 / n, 0, h / 2, -1.5 + (i + 0.5) * (3 / n)); } return s; },
  cols: [{ r: [0, 0.6, 0, 2, 0.6, 1.5], dir: 1 }] });
def('ramp', { label: 'Ramp', cat: 'roof', kind: 'part', mat: 'concrete', mats: ['concrete', 'wood', 'asphalt', 'stonetiles', 'metal'], snap: 'grid1', size: [2, 1, 4],
  shape: () => { const ang = Math.atan2(1, 4); return new Shape().box(0, 2, 0.15, Math.hypot(4, 1), 0, 0.5, 0, -ang); },
  cols: [{ r: [0, 0.5, 0, 1, 0.5, 2], dir: 1 }] });
def('railing', { label: 'Railing', cat: 'roof', kind: 'part', mat: 'metal', mats: ['metal', 'wooddark', 'wood', 'paint'], snap: 'edge', size: [W, 1.05, 0.08],
  shape: () => { const s = new Shape(); s.box(0, W, 0.06, 0.08, 0, 1.02, 0); s.box(0, W, 0.04, 0.04, 0, 0.5, 0); for (let i = 0; i <= 8; i++) s.box(0, 0.035, 1, 0.035, -W / 2 + 0.03 + i * ((W - 0.06) / 8), 0.5, 0); return s; },
  cols: [{ b: [0, 0.55, 0, W / 2, 0.55, 0.06] }] });

// ---- roads & ground
def('road', { label: 'Road', cat: 'ground', kind: 'part', mat: 'asphalt', mats: ['asphalt', 'cobble', 'concrete', 'gravel'], snap: 'grid4', size: [8, 0.12, 8], slots: [null, 'paint'], flat: true,
  shape: () => { const s = new Shape().box(0, 8, 0.12, 8, 0, 0.06, 0); s.box(1, 0.14, 0.02, 2.2, 0, 0.125, -2.0).box(1, 0.14, 0.02, 2.2, 0, 0.125, 2.0); s.box(1, 0.12, 0.02, 8, -3.7, 0.125, 0).box(1, 0.12, 0.02, 8, 3.7, 0.125, 0); return s; },
  cols: [{ b: [0, 0.06, 0, 4, 0.06, 4] }] });
def('road_plain', { label: 'Junction', cat: 'ground', kind: 'part', mat: 'asphalt', mats: ['asphalt', 'cobble', 'concrete', 'gravel'], snap: 'grid4', size: [8, 0.12, 8], flat: true,
  shape: () => new Shape().box(0, 8, 0.12, 8, 0, 0.06, 0), cols: [{ b: [0, 0.06, 0, 4, 0.06, 4] }] });
def('crossing', { label: 'Zebra crossing', cat: 'ground', kind: 'part', mat: 'asphalt', mats: ['asphalt'], snap: 'grid4', size: [8, 0.12, 4], slots: [null, 'paint'], flat: true,
  shape: () => { const s = new Shape().box(0, 8, 0.12, 4, 0, 0.06, 0); for (let i = 0; i < 7; i++) s.box(1, 0.6, 0.02, 3, -3.3 + i * 1.1, 0.125, 0); return s; }, cols: [{ b: [0, 0.06, 0, 4, 0.06, 2] }] });
def('sidewalk', { label: 'Sidewalk', cat: 'ground', kind: 'part', mat: 'pavers', mats: GROUND_MATS, snap: 'grid2', size: [4, 0.25, 2], slots: [null, 'concrete'], flat: true,
  shape: () => new Shape().box(0, 4, 0.25, 1.8, 0, 0.125, -0.1).box(1, 4, 0.26, 0.2, 0, 0.13, 0.9), cols: [{ b: [0, 0.125, 0, 2, 0.13, 1] }] });
def('plaza', { label: 'Paving tile', cat: 'ground', kind: 'part', mat: 'pavers', mats: GROUND_MATS, snap: 'grid4', size: [4, 0.15, 4], flat: true,
  shape: () => new Shape().box(0, 4, 0.15, 4, 0, 0.075, 0), cols: [{ b: [0, 0.075, 0, 2, 0.075, 2] }] });
def('path', { label: 'Garden path', cat: 'ground', kind: 'part', mat: 'gravel', mats: GROUND_MATS, snap: 'grid1', size: [1.6, 0.06, 4], flat: true,
  shape: () => new Shape().box(0, 1.6, 0.06, 4, 0, 0.03, 0), cols: [{ b: [0, 0.03, 0, 0.8, 0.03, 2] }] });
def('deck', { label: 'Deck / pier', cat: 'ground', kind: 'part', mat: 'weathered', mats: ['weathered', 'wood', 'wooddark', 'concrete'], snap: 'grid4', size: [4, 0.25, 4], slots: [null, 'wooddark'],
  shape: () => { const s = new Shape().box(0, 4, 0.2, 4, 0, 0.1, 0); for (const x of [-1.8, 1.8]) for (const z of [-1.8, 1.8]) s.cyl(1, 0.12, 0.12, 4, x, -1.9, z, 8); return s; },
  cols: [{ b: [0, 0.1, 0, 2, 0.1, 2] }] });
def('bridge', { label: 'Bridge (12 m)', cat: 'ground', kind: 'part', mat: 'wood', mats: ['wood', 'wooddark', 'weathered', 'concrete', 'stonetiles'], snap: 'grid4', size: [4, 1.3, 12], slots: [null, 'metal'],
  shape: () => { const s = new Shape().box(0, 4, 0.3, 12, 0, 0.15, 0); for (const x of [-1.95, 1.95]) { s.box(1, 0.08, 0.08, 12, x, 1.05, 0); for (let i = 0; i <= 12; i++) s.box(1, 0.06, 0.9, 0.06, x, 0.6, -6 + i); } return s; },
  cols: [{ b: [0, 0.15, 0, 2, 0.15, 6] }, { b: [-1.95, 0.7, 0, 0.06, 0.4, 6] }, { b: [1.95, 0.7, 0, 0.06, 0.4, 6] }] });
def('pool', { label: 'Swimming pool', cat: 'ground', kind: 'part', mat: 'tiles', mats: ['tiles', 'marbletile', 'stonetiles', 'concrete'], snap: 'grid4', size: [8, 0.3, 4], slots: [null, 'water'], flat: true,
  shape: () => { const s = new Shape(); s.box(0, 8, 0.3, 0.5, 0, 0.15, -1.75).box(0, 8, 0.3, 0.5, 0, 0.15, 1.75).box(0, 0.5, 0.3, 3, -3.75, 0.15, 0).box(0, 0.5, 0.3, 3, 3.75, 0.15, 0).box(0, 7, 0.1, 3, 0, -1.3, 0); s.box(1, 7, 0.02, 3, 0, 0.1, 0); return s; },
  cols: [{ b: [0, 0.15, -1.75, 4, 0.15, 0.25] }, { b: [0, 0.15, 1.75, 4, 0.15, 0.25] }, { b: [-3.75, 0.15, 0, 0.25, 0.15, 1.5] }, { b: [3.75, 0.15, 0, 0.25, 0.15, 1.5] }] });

// ---- fences & outdoor
def('fence', { label: 'Wooden fence', cat: 'outdoor', kind: 'part', mat: 'weathered', mats: ['weathered', 'wood', 'wooddark', 'paint', 'bluewood'], snap: 'edge', size: [W, 1.2, 0.12],
  shape: () => { const s = new Shape(); for (const x of [-1.95, 0, 1.95]) s.box(0, 0.12, 1.2, 0.12, x, 0.6, 0); for (const y of [0.35, 0.95]) s.box(0, W, 0.12, 0.05, 0, y, 0.06); return s; },
  cols: [{ b: [0, 0.6, 0, W / 2, 0.6, 0.08] }] });
def('picket', { label: 'Picket fence', cat: 'outdoor', kind: 'part', mat: 'paint', mats: ['paint', 'wood', 'weathered', 'bluewood'], snap: 'edge', size: [W, 1, 0.1],
  shape: () => { const s = new Shape(); for (let i = 0; i < 20; i++) s.box(0, 0.09, 1, 0.025, -W / 2 + 0.1 + i * 0.2, 0.5, 0.03); for (const y of [0.25, 0.75]) s.box(0, W, 0.07, 0.04, 0, y, 0); return s; },
  cols: [{ b: [0, 0.5, 0, W / 2, 0.5, 0.06] }] });
def('stone_wall', { label: 'Stone wall', cat: 'outdoor', kind: 'part', mat: 'stonewall', mats: ['stonewall', 'stone', 'brick', 'sandstone', 'concrete'], snap: 'edge', size: [W, 1, 0.5],
  shape: () => new Shape().box(0, W, 1, 0.5, 0, 0.5, 0).box(0, W + 0.04, 0.1, 0.58, 0, 1.03, 0), cols: [{ b: [0, 0.54, 0, W / 2, 0.54, 0.29] }] });
def('planter', { label: 'Raised bed', cat: 'outdoor', kind: 'part', mat: 'weathered', mats: ['weathered', 'wood', 'brick', 'stone', 'concrete'], snap: 'grid1', size: [2, 0.5, 1], slots: [null, 'soil'],
  shape: () => new Shape().box(0, 2, 0.5, 0.08, 0, 0.25, 0.46).box(0, 2, 0.5, 0.08, 0, 0.25, -0.46).box(0, 0.08, 0.5, 0.84, 0.96, 0.25, 0).box(0, 0.08, 0.5, 0.84, -0.96, 0.25, 0).box(1, 1.84, 0.05, 0.84, 0, 0.42, 0),
  cols: [{ b: [0, 0.25, 0, 1, 0.25, 0.5] }] });
def('gazebo', { label: 'Pergola', cat: 'outdoor', kind: 'part', mat: 'wood', mats: ['wood', 'wooddark', 'weathered', 'metal', 'paint'], snap: 'grid4', size: [4, 2.8, 4],
  shape: () => { const s = new Shape(); for (const x of [-1.85, 1.85]) for (const z of [-1.85, 1.85]) s.box(0, 0.15, 2.6, 0.15, x, 1.3, z); for (const z of [-1.85, 1.85]) s.box(0, 4.2, 0.18, 0.12, 0, 2.65, z); for (let i = 0; i < 9; i++) s.box(0, 0.08, 0.12, 4.4, -1.9 + i * 0.475, 2.8, 0); return s; },
  cols: [-1.85, 1.85].flatMap((x) => [-1.85, 1.85].map((z) => ({ b: [x, 1.3, z, 0.08, 1.3, 0.08] }))) });

def('fountain', { label: 'Fountain', cat: 'outdoor', kind: 'part', mat: 'sandstone', mats: ['sandstone', 'stone', 'marble', 'granite', 'concrete', 'stonewall'], snap: 'grid1', size: [6.6, 2.1, 6.6], slots: [null, 'water'],
  fountain: true,
  shape: () => {
    const s = new Shape();
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; s.box(0, 0.9, 0.6, 0.34, Math.cos(a) * 3.1, 0.3, Math.sin(a) * 3.1, 0, -a + Math.PI / 2); }
    s.cyl(0, 3.0, 3.0, 0.12, 0, 0.06, 0, 32).cyl(0, 0.42, 0.55, 1.35, 0, 0.75, 0, 16).cyl(0, 1.15, 0.45, 0.3, 0, 1.55, 0, 24).cyl(0, 0.18, 0.25, 0.45, 0, 1.9, 0, 12);
    s.cyl(1, 2.95, 2.95, 0.04, 0, 0.42, 0, 32).cyl(1, 1.05, 1.05, 0.03, 0, 1.68, 0, 24);
    return s;
  },
  cols: [...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const a = (i / 8) * Math.PI * 2; return { b: [Math.cos(a) * 3.1, 0.3, Math.sin(a) * 3.1, 1.25, 0.3, 1.25] }; }), { b: [0, 1, 0, 0.55, 1, 0.55] }] });
def('signpost', { label: 'Sign post', cat: 'outdoor', kind: 'part', mat: 'wooddark', mats: ['wooddark', 'wood', 'weathered', 'metal'], snap: 'free', size: [1.4, 2.4, 0.2], slots: [null, 'signwood'],
  shape: () => new Shape().box(0, 0.12, 2.4, 0.12, 0, 1.2, 0).box(1, 1.3, 0.32, 0.05, 0.45, 2.05, 0).box(1, 1.1, 0.32, 0.05, -0.35, 1.6, 0), cols: [{ b: [0, 1.2, 0, 0.08, 1.2, 0.08] }] });

// ---- lighting (procedural ones; Poly Haven lamps below)
def('lamp_post', { label: 'Lamp post', cat: 'lighting', kind: 'part', mat: 'metal', mats: ['metal', 'paint', 'wooddark'], snap: 'grid1', size: [0.5, 4.2, 0.5], slots: [null, 'emissive'],
  light: { y: 3.9, color: '#ffd9a0', intensity: 40, distance: 22 },
  shape: () => new Shape().cyl(0, 0.07, 0.11, 4, 0, 2, 0, 10).cyl(0, 0.2, 0.2, 0.3, 0, 0.15, 0, 10).cyl(0, 0.26, 0.12, 0.12, 0, 4.18, 0, 12).add(1, (() => { const g = new THREE.CylinderGeometry(0.15, 0.2, 0.32, 12); g.translate(0, 3.96, 0); return g; })()),
  cols: [{ b: [0, 2.1, 0, 0.12, 2.1, 0.12] }] });
def('bollard', { label: 'Path light', cat: 'lighting', kind: 'part', mat: 'metal', mats: ['metal', 'paint', 'concrete'], snap: 'free', size: [0.2, 0.7, 0.2], slots: [null, 'emissive'],
  light: { y: 0.6, color: '#ffe1b0', intensity: 4, distance: 7 },
  shape: () => new Shape().cyl(0, 0.08, 0.08, 0.55, 0, 0.275, 0, 10).cyl(0, 0.1, 0.1, 0.05, 0, 0.72, 0, 10).add(1, (() => { const g = new THREE.CylinderGeometry(0.075, 0.075, 0.13, 10); g.translate(0, 0.62, 0); return g; })()),
  cols: [{ b: [0, 0.35, 0, 0.1, 0.35, 0.1] }] });
def('ceiling_light', { label: 'Ceiling light', cat: 'lighting', kind: 'part', mat: 'paint', mats: ['paint', 'metal'], snap: 'free', size: [0.6, 0.08, 0.6], slots: [null, 'emissive'], hang: true,
  light: { y: -0.3, color: '#fff0d8', intensity: 10, distance: 10 },
  shape: () => new Shape().cyl(0, 0.3, 0.3, 0.04, 0, 0.04, 0, 20).add(1, (() => { const g = new THREE.CylinderGeometry(0.26, 0.26, 0.02, 20); g.translate(0, 0.01, 0); return g; })()), cols: [] });
def('light_panel', { label: 'Light block', cat: 'lighting', kind: 'part', mat: 'emissive', mats: ['emissive'], snap: 'grid1', size: [1, 0.1, 1],
  light: { y: 0.5, color: '#fff2d0', intensity: 8, distance: 10 },
  shape: () => new Shape().box(0, 1, 0.1, 1, 0, 0.05, 0), cols: [{ b: [0, 0.05, 0, 0.5, 0.05, 0.5] }] });

// ---- Poly Haven models: [id, label, category, extra]
const MODELS = [
  ['Sofa_01', 'Sofa', 'furniture'], ['sofa_03', 'Corner sofa', 'furniture'], ['chinese_sofa', 'Daybed sofa', 'furniture'],
  ['ArmChair_01', 'Armchair', 'furniture'], ['mid_century_lounge_chair', 'Lounge chair', 'furniture'], ['Rockingchair_01', 'Rocking chair', 'furniture'],
  ['Ottoman_01', 'Ottoman', 'furniture'], ['GreenChair_01', 'Green chair', 'furniture'], ['dining_chair_02', 'Dining chair', 'furniture'],
  ['bar_chair_round_01', 'Bar stool', 'furniture'], ['CoffeeTable_01', 'Coffee table', 'furniture'], ['modern_coffee_table_01', 'Modern coffee table', 'furniture'],
  ['round_wooden_table_01', 'Round table', 'furniture'], ['WoodenTable_01', 'Wooden table', 'furniture'], ['side_table_01', 'Side table', 'furniture'],
  ['GothicBed_01', 'Bed', 'furniture'], ['vintage_day_bed', 'Day bed', 'furniture'], ['ClassicNightstand_01', 'Nightstand', 'furniture'],
  ['Shelf_01', 'Shelf', 'furniture'], ['wooden_bookshelf_worn', 'Bookshelf', 'furniture'], ['drawer_cabinet', 'Drawer cabinet', 'furniture'],
  ['modern_wooden_cabinet', 'Sideboard', 'furniture'], ['wooden_display_shelves_01', 'Display shelves', 'furniture'], ['Television_01', 'Retro TV', 'furniture'],
  ['electric_stove', 'Stove', 'furniture'], ['scandinavian_masonry_heater', 'Fireplace heater', 'furniture'], ['vintage_grandfather_clock_01', 'Grandfather clock', 'furniture'],
  ['ornate_mirror_01', 'Mirror', 'furniture', { wall: true }], ['fancy_picture_frame_01', 'Picture frame', 'furniture', { wall: true }], ['potted_plant_02', 'Potted plant', 'furniture'],
  ['ceramic_vase_01', 'Vase', 'furniture'], ['boombox', 'Boombox', 'furniture'],
  ['street_lamp_01', 'Street lamp', 'lighting', { light: { y: 3.6, color: '#ffd29a', intensity: 45, distance: 24 } }],
  ['street_lamp_02', 'Wall lamp', 'lighting', { light: { y: 1.3, color: '#ffd29a', intensity: 12, distance: 12 } }],
  ['Chandelier_01', 'Chandelier', 'lighting', { hang: true, light: { y: 0.3, color: '#ffe0b0', intensity: 14, distance: 12 } }],
  ['modern_ceiling_lamp_01', 'Pendant lamp', 'lighting', { hang: true, light: { y: 0.1, color: '#fff0d8', intensity: 10, distance: 10 } }],
  ['hanging_industrial_lamp', 'Industrial lamp', 'lighting', { hang: true, light: { y: 0.2, color: '#ffe8c0', intensity: 10, distance: 10 } }],
  ['wooden_lantern_01', 'Lantern', 'lighting', { light: { y: 0.3, color: '#ffbe70', intensity: 3, distance: 6 } }],
  ['security_light', 'Flood light', 'lighting', { light: { y: 0.3, color: '#f2f5ff', intensity: 20, distance: 16 } }],
  ['wooden_picnic_table', 'Picnic table', 'outdoor'], ['painted_wooden_bench', 'Bench', 'outdoor'], ['outdoor_table_chair_set_01', 'Cafe table set', 'outdoor'],
  ['modular_street_seating', 'Street seating', 'outdoor'], ['stone_fire_pit', 'Fire pit', 'outdoor', { light: { y: 0.6, color: '#ff9a4a', intensity: 8, distance: 9 } }],
  ['planter_box_01', 'Planter box', 'outdoor'], ['metal_trash_can', 'Trash bins', 'outdoor'], ['fire_hydrant', 'Fire hydrant', 'outdoor'],
  ['large_iron_gate', 'Iron gate', 'outdoor'], ['concrete_road_barrier', 'Road barrier', 'outdoor'], ['utility_box_01', 'Utility box', 'outdoor'],
  ['CoffeeCart_01', 'Coffee cart', 'outdoor'],
  ['covered_car', 'Covered car', 'decor'], ['dutch_ship_medium', 'Sailing ship', 'decor', { floats: true }],
  ['gothic_statue', 'Statue', 'decor'], ['bronze_whale_statue', 'Whale sculpture', 'decor'], ['marble_bust_01', 'Marble bust', 'decor'],
  ['garden_gnome', 'Garden gnome', 'decor'], ['treasure_chest', 'Treasure chest', 'decor'], ['wooden_crate_01', 'Crate', 'decor'],
  ['boulder_01', 'Boulder', 'nature'], ['namaqualand_boulder_02', 'Flat boulder', 'nature'], ['rock_09', 'Small rock', 'nature'],
  ['stone_01', 'Stone', 'nature'], ['tree_stump_01', 'Tree stump', 'nature'], ['dead_tree_trunk', 'Fallen log', 'nature'],
  ['shrub_02', 'Shrub', 'nature'], ['fern_02', 'Fern', 'nature'], ['wild_rooibos_bush', 'Wild bush', 'nature'],
];
for (const [id, label, cat, extra] of MODELS) {
  def('m:' + id, { label, cat, kind: 'model', model: id, snap: 'free', thumb: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=160&height=160`, ...(extra || {}) });
}

// ---- vehicles (see vehicles.js): drawn and driven by the vehicle system, not the instanced pools
def('v:car',  { label: 'Sports car', cat: 'vehicles', kind: 'vehicle', vtype: 'car',  snap: 'free', size: [1.95, 1.2, 4.6] });
def('v:bike', { label: 'Bicycle',    cat: 'vehicles', kind: 'vehicle', vtype: 'bike', snap: 'free', size: [0.6, 1.05, 1.75] });
def('v:boat', { label: 'Motor boat', cat: 'vehicles', kind: 'vehicle', vtype: 'boat', snap: 'free', size: [1.8, 1.0, 5.0], floats: true });

// places you can sit (E): seat height in metres and how many people fit side by side
const SEATS = {
  Sofa_01: { h: 0.42, n: 3 }, sofa_03: { h: 0.42, n: 4 }, chinese_sofa: { h: 0.45, n: 3 }, ArmChair_01: { h: 0.42 },
  mid_century_lounge_chair: { h: 0.36 }, Rockingchair_01: { h: 0.42 }, Ottoman_01: { h: 0.4 }, GreenChair_01: { h: 0.45 },
  dining_chair_02: { h: 0.47 }, bar_chair_round_01: { h: 0.74 }, GothicBed_01: { h: 0.58, n: 2, bed: true },
  vintage_day_bed: { h: 0.45, n: 2, bed: true }, painted_wooden_bench: { h: 0.45, n: 2 }, modular_street_seating: { h: 0.45, n: 5 },
  wooden_picnic_table: { h: 0.45, n: 2, dz: 0.62 },
};
for (const [id, s] of Object.entries(SEATS)) if (ITEMS['m:' + id]) ITEMS['m:' + id].seat = s;

// ---- trees
for (const [k, sp] of Object.entries(SPECIES)) def('tree:' + k, { label: sp.label, cat: 'nature', kind: 'tree', species: k, snap: 'free' });

// ---- garden: crops planted on the ground or in a raised bed; they grow from a sprout to ripe over
// GROW_MS of shared server time, then E harvests them (and they grow again)
function sphere(r, sx = 1, sy = 1, sz = 1, x = 0, y = 0, z = 0, seg = 10) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2));
  g.scale(sx, sy, sz); g.translate(x, y, z);
  return g;
}
function leafRosette(s, slot, n, r, y, size, tilt = 0.35) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + i * 0.37;
    const g = sphere(size, 1, 0.18, 0.55, 0, 0, 0, 8);
    g.rotateZ(tilt); g.translate(r, 0, 0); g.rotateY(-a); g.translate(0, y + (i % 3) * 0.04, 0);
    s.add(slot, g);
  }
}
const CROPS = {
  tomato: { label: 'Tomatoes', young: (s) => { s.cyl(0, 0.015, 0.02, 0.45, 0, 0.22, 0, 6); leafRosette(s, 1, 7, 0.12, 0.25, 0.12); },
    ripe: (s) => { s.cyl(0, 0.018, 0.025, 0.8, 0, 0.4, 0, 6); leafRosette(s, 1, 9, 0.16, 0.45, 0.15); leafRosette(s, 1, 6, 0.1, 0.7, 0.12); for (let i = 0; i < 7; i++) { const a = i * 2.1; s.add(2, sphere(0.05, 1, 0.92, 1, Math.cos(a) * 0.15, 0.3 + (i % 3) * 0.14, Math.sin(a) * 0.15)); } },
    slots: ['stem', 'leaf', 'tomato'] },
  sunflower: { label: 'Sunflower', young: (s) => { s.cyl(0, 0.02, 0.025, 0.8, 0, 0.4, 0, 6); leafRosette(s, 1, 6, 0.1, 0.4, 0.13, 0.2); },
    ripe: (s) => { s.cyl(0, 0.028, 0.035, 1.9, 0, 0.95, 0, 6); leafRosette(s, 1, 8, 0.14, 0.7, 0.18, 0.2); const head = sphere(0.2, 1, 1, 0.3, 0, 0, 0, 16); head.rotateX(-0.35); head.translate(0, 1.95, 0.08); s.add(2, head); for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; const p = sphere(0.1, 0.45, 1, 0.12, Math.cos(a) * 0.27, Math.sin(a) * 0.27, 0, 6); p.rotateZ(a - Math.PI / 2 + Math.PI / 2); p.rotateX(-0.35); p.translate(0, 1.95, 0.06); s.add(3, p); } },
    slots: ['stem', 'leaf', 'seeds', 'petal'] },
  cabbage: { label: 'Cabbages', young: (s) => { leafRosette(s, 1, 6, 0.06, 0.03, 0.09, 0.5); },
    ripe: (s) => { s.add(0, sphere(0.2, 1, 0.85, 1, 0, 0.2, 0, 14)); leafRosette(s, 1, 8, 0.2, 0.08, 0.17, 0.6); },
    slots: ['leaf2', 'leaf'] },
  corn: { label: 'Corn', young: (s) => { s.cyl(0, 0.02, 0.025, 0.7, 0, 0.35, 0, 6); leafRosette(s, 1, 4, 0.12, 0.35, 0.2, 0.6); },
    ripe: (s) => { s.cyl(0, 0.03, 0.035, 2.1, 0, 1.05, 0, 6); leafRosette(s, 1, 6, 0.2, 0.6, 0.32, 0.9); leafRosette(s, 1, 4, 0.18, 1.3, 0.28, 0.9); s.add(2, sphere(0.06, 1, 2.6, 1, 0.08, 1.0, 0.03)); s.add(2, sphere(0.055, 1, 2.4, 1, -0.07, 1.2, -0.04)); },
    slots: ['stem', 'leaf', 'corn'] },
  pumpkin: { label: 'Pumpkins', young: (s) => { leafRosette(s, 1, 6, 0.16, 0.04, 0.15, 0.4); },
    ripe: (s) => { leafRosette(s, 1, 9, 0.38, 0.05, 0.22, 0.5); s.add(2, sphere(0.34, 1.15, 0.75, 1.15, 0, 0.25, 0, 18)); s.cyl(0, 0.03, 0.04, 0.12, 0, 0.53, 0, 6); },
    slots: ['stem', 'leaf', 'pumpkin'] },
  flowers: { label: 'Flower patch', young: (s) => { leafRosette(s, 0, 8, 0.12, 0.03, 0.1, 0.5); },
    ripe: (s) => { leafRosette(s, 0, 10, 0.2, 0.05, 0.12, 0.5); const cols = [1, 2, 3, 4]; for (let i = 0; i < 16; i++) { const a = i * 2.4, r = 0.08 + (i % 4) * 0.07; s.cyl(0, 0.008, 0.008, 0.3, Math.cos(a) * r, 0.15, Math.sin(a) * r, 4); s.add(cols[i % 4], sphere(0.045, 1, 0.6, 1, Math.cos(a) * r, 0.31, Math.sin(a) * r, 8)); } },
    slots: ['leaf', 'pink', 'lilac', 'snowwhite', 'petal'] },
};
for (const [k, c] of Object.entries(CROPS)) {
  def('crop:' + k + ':ripe', { label: c.label + ' (ripe)', cat: 'hidden', kind: 'part', slots: c.slots, fixedSlots: true, snap: 'free', size: [0.6, 0.8, 0.6], shape: () => { const s = new Shape(); c.ripe(s); return s; }, cols: [] });
  def('crop:' + k, { label: c.label, cat: 'garden', kind: 'part', slots: c.slots, fixedSlots: true, snap: 'free', size: [0.5, 0.5, 0.5], crop: { ripe: 'crop:' + k + ':ripe', name: c.label.toLowerCase() }, shape: () => { const s = new Shape(); c.young(s); return s; }, cols: [] });
}

// ------------------------------------------------------------------ geometry cache
const geoCache = new Map();
export function partGeometry(id) {
  if (geoCache.has(id)) return geoCache.get(id);
  const it = ITEMS[id];
  const g = it.shape().build();
  geoCache.set(id, g);
  return g;
}

// model sizes arrive with the model; until then a 1 m cube stands in for picking/colliders
export const modelSizes = new Map();
// Which way a seat faces in its own frame: +1 = +z, -1 = -z. Worked out from the geometry when the model
// loads (the backrest is the tall part, the seat faces away from it); the bench is known up front because
// the town places benches before any model has downloaded.
export const modelFront = new Map([['painted_wooden_bench', -1]]);
export function learnFront(id, parts) {
  if (modelFront.has(id)) return;
  let top = -Infinity;
  for (const p of parts) { p.geometry.computeBoundingBox(); top = Math.max(top, p.geometry.boundingBox.max.y); }
  let sum = 0, n = 0;
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 3) if (pos.getY(i) > top * 0.75) { sum += pos.getZ(i); n++; }
  }
  modelFront.set(id, n && Math.abs(sum / n) > 0.02 ? -Math.sign(sum / n) : 1);
}
export function itemSize(it) {
  if (it.kind === 'model') return modelSizes.get(it.model) || [1, 1, 1];
  if (it.kind === 'tree') return [3, 10, 3];
  return it.size;
}

// collision volumes in the item's local frame (before rotation and scale)
export function itemColliders(it) {
  if (it.kind === 'part') return it.cols || [];
  if (it.kind === 'vehicle') { const s = it.size; return it.vtype === 'boat' ? [] : [{ b: [0, s[1] / 2, 0, s[0] / 2, s[1] / 2, s[2] / 2] }]; }
  if (it.kind === 'model') {
    if (it.hang || it.wall) return [];
    const s = modelSizes.get(it.model);
    if (!s) return [];
    if (s[0] < 0.35 && s[2] < 0.35) return [];  // tiny props: walk through
    return [{ b: [0, s[1] / 2, 0, s[0] / 2, s[1] / 2, s[2] / 2] }];
  }
  return [];
}
