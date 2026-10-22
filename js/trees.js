// Procedural trees: branching bark tubes + alpha leaf cards, swaying in the wind, drawn as instanced
// meshes near the camera and as baked billboard impostors in the distance. Covers both the island's
// natural forests (generated from the seed) and trees players plant.
import * as THREE from 'three';
import { rng, hash2 } from './noise.js';
import { phTexture, leafTexture } from './assets.js';
import { HALF, SPAWN } from './config.js';

export const SPECIES = {
  oak:   { label: 'Oak',        bark: 'brown', leaf: 'oak',   h: [9, 14],  form: 'broad', depth: 3, kids: [6, 3, 3], spread: 0.95, leafSize: 2.2, leaves: 5 },
  maple: { label: 'Autumn maple', bark: 'brown', leaf: 'maple', h: [8, 12], form: 'broad', depth: 3, kids: [5, 3, 3], spread: 0.8, leafSize: 2.0, leaves: 6 },
  birch: { label: 'Birch',      bark: 'birch', leaf: 'birch', h: [10, 15], form: 'slim',  depth: 2, kids: [9, 4],    spread: 0.45, leafSize: 1.5, leaves: 7 },
  pine:  { label: 'Pine',       bark: 'pine',  leaf: 'pine',  h: [13, 22], form: 'conifer' },
  palm:  { label: 'Palm',       bark: 'palm',  leaf: 'palm',  h: [7, 11],  form: 'palm' },
  bush:  { label: 'Bush',       bark: 'brown', leaf: 'bush',  h: [1.2, 2], form: 'bush' },
};
const VARIANTS = 3;

// shared wind uniforms for every tree material
export const wind = { uWindTime: { value: 0 }, uWind: { value: 1 } };

function windify(mat, leaf) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.uWindTime = wind.uWindTime;
    sh.uniforms.uWind = wind.uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime; uniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 wp = instanceMatrix[3].xz;
        #else
          vec2 wp = modelMatrix[3].xz;
        #endif
        float wph = dot(wp, vec2(0.131, 0.173));
        float hgt = max(position.y, 0.0);
        float bend = hgt * hgt / (1.0 + hgt * 0.08);
        transformed.x += (sin(uWindTime * 1.1 + wph) * 0.6 + sin(uWindTime * 2.37 + wph * 1.7) * 0.25) * uWind * 0.010 * bend;
        transformed.z += cos(uWindTime * 0.83 + wph) * uWind * 0.006 * bend;
        ${leaf ? 'transformed += normal * sin(uWindTime * 5.0 + dot(position, vec3(3.1, 2.7, 1.9)) + wph) * 0.05 * uWind;' : ''}`);
  };
  mat.customProgramCacheKey = () => (leaf ? 'treeLeaf' : 'treeBark') + (prev ? 'x' : '');
}

// ------------------------------------------------------------------ materials
function birchBarkTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#e4e0d6'; g.fillRect(0, 0, 128, 512);
  let s = 77; const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(150,140,125,${r() * 0.12})`; g.fillRect(r() * 128, r() * 512, 1 + r() * 4, 1 + r() * 2); }
  for (let i = 0; i < 70; i++) {
    const y = r() * 512, w = 6 + r() * 40, x = r() * 128;
    g.fillStyle = `rgba(30,26,22,${0.55 + r() * 0.4})`; g.fillRect(x, y, w, 1.5 + r() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const barkMats = {};
function barkMaterial(kind) {
  if (barkMats[kind]) return barkMats[kind];
  const m = new THREE.MeshStandardMaterial({ color: kind === 'palm' ? '#b8a68c' : '#ffffff', roughness: 0.95 });
  if (kind === 'birch') m.map = birchBarkTexture();
  else {
    const id = kind === 'pine' ? 'pine_bark' : 'bark_brown_02';
    m.color.set(kind === 'palm' ? '#c9b89c' : '#8a7a6a');
    phTexture(id, 'diff', true, '1k').then((t) => { if (t) { m.map = t; m.color.set(kind === 'palm' ? '#d8c8ad' : '#ffffff'); m.needsUpdate = true; } });
    phTexture(id, 'nor_gl', false, '1k').then((t) => { if (t) { m.normalMap = t; m.needsUpdate = true; } });
  }
  windify(m, false);
  barkMats[kind] = m;
  return m;
}
const leafMats = {};
function leafMaterial(kind) {
  if (leafMats[kind]) return leafMats[kind];
  const map = leafTexture(kind);
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, metalness: 0 });
  // a touch of light transmitted through the leaves
  m.emissive = new THREE.Color(kind === 'maple' ? '#3a1404' : '#0c1a04');
  m.emissiveMap = map;
  windify(m, true);
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.45, side: THREE.DoubleSide });
  windify(d, true);
  leafMats[kind] = { mat: m, depth: d };
  return leafMats[kind];
}

// ------------------------------------------------------------------ geometry builders
class Builder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
// a tapered tube through points with radii
function tube(b, pts, rads, sides) {
  const base = b.count;
  let vAcc = 0;
  let side = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const t = new THREE.Vector3().subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
    if (i === 0) { side.crossVectors(t, Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize(); }
    else side.sub(t.clone().multiplyScalar(side.dot(t))).normalize();       // parallel transport
    const bi = new THREE.Vector3().crossVectors(t, side);
    if (i > 0) vAcc += pts[i].distanceTo(pts[i - 1]);
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const n = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(bi, Math.sin(a));
      const p = pts[i].clone().addScaledVector(n, rads[i]);
      b.pos.push(p.x, p.y, p.z); b.nrm.push(n.x, n.y, n.z);
      b.uv.push(k / sides * Math.max(1, Math.round(rads[0] * 8)), vAcc / 1.6);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < sides; k++) {
    const a = base + i * (sides + 1) + k, c = a + sides + 1;
    b.idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
}

// a leaf card centred at p; normals bend away from the crown centre so the canopy shades like a volume
function card(b, p, size, rnd, centre, tilt = 1) {
  const base = b.count;
  const n = new THREE.Vector3(rnd() - 0.5, (rnd() - 0.2) * tilt, rnd() - 0.5).normalize();
  const t = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
  const bt = new THREE.Vector3().crossVectors(n, t);
  const out = p.clone().sub(centre).normalize();
  const sn = out.multiplyScalar(0.75).addScaledVector(n, 0.25).normalize();
  const h = size / 2;
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const q = p.clone().addScaledVector(t, (u - 0.5) * size).addScaledVector(bt, (v - 0.5) * size);
    b.pos.push(q.x, q.y, q.z); b.nrm.push(sn.x, sn.y, sn.z); b.uv.push(u, v);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  return h;
}

function randomDir(rnd, axis, angle) {
  // a direction at `angle` from axis with random azimuth
  const perp = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
  perp.applyAxisAngle(axis, rnd() * Math.PI * 2);
  return axis.clone().multiplyScalar(Math.cos(angle)).addScaledVector(perp, Math.sin(angle)).normalize();
}

function buildBroad(sp, rnd) {
  const bark = new Builder(), leaf = new Builder();
  const H = sp.h[0] + rnd() * (sp.h[1] - sp.h[0]);
  const trunkR = H * (sp.form === 'slim' ? 0.022 : 0.034);
  const crownC = new THREE.Vector3(0, H * 0.68, 0);
  const grow = (start, dir, len, r0, depth) => {
    const segs = depth === 0 ? 8 : depth === 1 ? 5 : 3;
    const pts = [start.clone()], rads = [r0];
    const p = start.clone(), d = dir.clone();
    for (let i = 1; i <= segs; i++) {
      d.add(new THREE.Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.4 + (depth ? 0.12 : 0.05), rnd() - 0.5).multiplyScalar(depth === 0 ? 0.12 : 0.35)).normalize();
      p.addScaledVector(d, len / segs);
      pts.push(p.clone()); rads.push(r0 * (1 - (i / segs) * 0.72));
    }
    tube(bark, pts, rads, depth === 0 ? 8 : depth === 1 ? 6 : 4);
    if (depth < sp.depth) {
      const n = sp.kids[depth];
      for (let k = 0; k < n; k++) {
        const t = depth === 0 ? (sp.form === 'slim' ? 0.3 : 0.42) + (k / n) * 0.55 + rnd() * 0.05 : 0.3 + rnd() * 0.65;
        const fi = Math.min(segs - 1, Math.floor(t * segs));
        const at = pts[fi].clone().lerp(pts[fi + 1], t * segs - fi);
        const ang = depth === 0 ? sp.spread * (0.7 + rnd() * 0.5) : 0.6 + rnd() * 0.5;
        const cd = randomDir(rnd, d.clone().lerp(UP, 0.3).normalize(), ang);
        const cl = len * (depth === 0 ? 0.55 - t * 0.25 : 0.6) * (0.8 + rnd() * 0.4);
        grow(at, cd, cl, rads[fi] * (depth === 0 ? 0.55 : 0.6), depth + 1);
      }
    } else {
      // twigs: leaf cards along the last two thirds
      for (let k = 0; k < sp.leaves; k++) {
        const t = 0.35 + rnd() * 0.65;
        const fi = Math.min(segs - 1, Math.floor(t * segs));
        const at = pts[fi].clone().lerp(pts[fi + 1], t * segs - fi);
        at.add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.4, rnd() - 0.5).multiplyScalar(0.7));
        card(leaf, at, sp.leafSize * (0.7 + rnd() * 0.6), rnd, crownC);
      }
    }
  };
  grow(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3((rnd() - 0.5) * 0.08, 1, (rnd() - 0.5) * 0.08).normalize(), H * (sp.form === 'slim' ? 0.92 : 0.62), trunkR, 0);
  // root flare
  return { bark: bark.geometry(), leaf: leaf.geometry(), h: H };
}

function buildConifer(sp, rnd) {
  const bark = new Builder(), leaf = new Builder();
  const H = sp.h[0] + rnd() * (sp.h[1] - sp.h[0]);
  const r0 = H * 0.022;
  const pts = [], rads = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(new THREE.Vector3((rnd() - 0.5) * 0.1, -0.3 + t * H, (rnd() - 0.5) * 0.1)); rads.push(r0 * (1 - t * 0.92)); }
  tube(bark, pts, rads, 8);
  const centre = new THREE.Vector3(0, H * 0.55, 0);
  const bottom = H * 0.18;
  for (let y = bottom; y < H - 0.4; y += 0.45 + rnd() * 0.25) {
    const t = (y - bottom) / (H - bottom);
    const n = 5 + Math.floor(rnd() * 3);
    const reach = (1 - t) * H * 0.26 + 0.35;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rnd() * 0.8;
      const dir = new THREE.Vector3(Math.cos(a), -0.15 - rnd() * 0.25, Math.sin(a)).normalize();
      const s = new THREE.Vector3(0, y, 0), e = s.clone().addScaledVector(dir, reach);
      tube(bark, [s, s.clone().lerp(e, 0.5).add(new THREE.Vector3(0, 0.05, 0)), e], [r0 * (1 - t) * 0.35 + 0.02, 0.025, 0.01], 3);
      const cards = Math.max(2, Math.round(reach * 2.4));
      for (let c = 0; c < cards; c++) {
        const p = s.clone().lerp(e, 0.25 + (c / cards) * 0.8);
        p.y += (rnd() - 0.3) * 0.25;
        card(leaf, p, 1.1 + rnd() * 0.6 + (1 - t) * 0.5, rnd, centre, 0.25);
      }
    }
  }
  // the leader at the very top
  for (let c = 0; c < 4; c++) card(leaf, new THREE.Vector3(0, H - 0.6 + c * 0.25, 0), 0.9, rnd, centre, 0.4);
  return { bark: bark.geometry(), leaf: leaf.geometry(), h: H };
}

function buildPalm(sp, rnd) {
  const bark = new Builder(), leaf = new Builder();
  const H = sp.h[0] + rnd() * (sp.h[1] - sp.h[0]);
  const lean = new THREE.Vector3(rnd() - 0.5, 0, rnd() - 0.5).normalize().multiplyScalar(H * 0.18);
  const pts = [], rads = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push(new THREE.Vector3(lean.x * t * t, -0.3 + t * H, lean.z * t * t));
    rads.push(0.24 * (1 - t * 0.35) * (i % 2 ? 0.94 : 1.0));   // ringed trunk
  }
  tube(bark, pts, rads, 9);
  const top = pts[pts.length - 1];
  const fronds = 11 + Math.floor(rnd() * 4);
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rnd() * 0.3;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const len = 3.6 + rnd() * 1.4, up = 0.5 + rnd() * 0.6;
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const base = leaf.count;
    const segs = 7;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = top.clone().addScaledVector(dir, t * len);
      p.y += up * Math.sin(t * Math.PI * 0.8) * 1.6 - t * t * 2.2;
      const w = 0.95 * Math.sin(Math.min(1, t * 1.2 + 0.1) * Math.PI) + 0.1;
      const n = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -0.3).normalize();
      for (const s of [-1, 1]) {
        const q = p.clone().addScaledVector(side, s * w).add(new THREE.Vector3(0, -Math.abs(s) * w * 0.25, 0));
        leaf.pos.push(q.x, q.y, q.z); leaf.nrm.push(n.x, n.y, n.z); leaf.uv.push(s < 0 ? 0 : 1, t);
      }
    }
    for (let i = 0; i < segs; i++) { const a0 = base + i * 2; leaf.idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2); }
  }
  return { bark: bark.geometry(), leaf: leaf.geometry(), h: H + 1 };
}

function buildBush(sp, rnd) {
  const bark = new Builder(), leaf = new Builder();
  const H = sp.h[0] + rnd() * (sp.h[1] - sp.h[0]);
  const centre = new THREE.Vector3(0, H * 0.45, 0);
  for (let s = 0; s < 4; s++) {
    const d = randomDir(rnd, UP, 0.5 + rnd() * 0.4);
    const e = d.clone().multiplyScalar(H * 0.8);
    tube(bark, [new THREE.Vector3(0, -0.1, 0), e.clone().multiplyScalar(0.5), e], [0.05, 0.03, 0.012], 4);
  }
  const R = H * 0.75;
  for (let k = 0; k < 46; k++) {
    const p = randomDir(rnd, UP, rnd() * 1.5).multiplyScalar(R * (0.4 + rnd() * 0.6));
    p.y = p.y * 0.8 + H * 0.35;
    card(leaf, p, 0.9 + rnd() * 0.6, rnd, centre);
  }
  return { bark: bark.geometry(), leaf: leaf.geometry(), h: H };
}

// ------------------------------------------------------------------ impostor (far LOD)
function crossQuads(w, h) {
  const b = new Builder();
  for (const rot of [0, Math.PI / 2]) {
    const c = Math.cos(rot), s = Math.sin(rot), base = b.count;
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const x = (u - 0.5) * w;
      b.pos.push(x * c, v * h - 0.2, x * s);
      b.nrm.push(-s * 0.4, 0.8, c * 0.4);
      b.uv.push(u, v);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return b.geometry();
}

// ------------------------------------------------------------------ the system
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();

export class Trees {
  constructor(scene, renderer, terrain) {
    this.scene = scene;
    this.renderer = renderer;
    this.terrain = terrain;
    this.variants = [];                       // per species x variant
    this.byKey = {};
    this.items = new Map();                   // id -> { vi, x, y, z, ry, s, hidden }
    this.grid = new Map();
    this.nearDist = 160;
    this.shadowDist = 80;
    this.lastLod = new THREE.Vector3(1e9, 0, 0);
    this.lodDirty = true;
    this.buildVariants();
  }

  buildVariants() {
    for (const [key, sp] of Object.entries(SPECIES)) {
      this.byKey[key] = [];
      for (let v = 0; v < VARIANTS; v++) {
        const rnd = rng(hash2(v, key.length * 31, 99) * 1e9);
        const g = sp.form === 'conifer' ? buildConifer(sp, rnd) : sp.form === 'palm' ? buildPalm(sp, rnd) : sp.form === 'bush' ? buildBush(sp, rnd) : buildBroad(sp, rnd);
        const lm = leafMaterial(sp.leaf);
        const bm = barkMaterial(sp.bark);
        const box = new THREE.Box3().union(g.bark.boundingBox).union(g.leaf.boundingBox);
        const radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
        const vi = this.variants.length;
        const mk = (geo, mat, cap) => {
          const m = new THREE.InstancedMesh(geo, mat, cap);
          m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
          m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          this.scene.add(m);
          return m;
        };
        const nearBark = mk(g.bark, bm, 16), nearLeaf = mk(g.leaf, lm.mat, 16);
        nearLeaf.customDepthMaterial = lm.depth;
        // same trees beyond the shadow range: drawn once, skipped by the shadow pass
        const midBark = mk(g.bark, bm, 16), midLeaf = mk(g.leaf, lm.mat, 16);
        midBark.castShadow = midLeaf.castShadow = false;
        const impMat = new THREE.MeshStandardMaterial({ alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, color: '#ffffff' });
        const far = mk(crossQuads(radius * 2.1, box.max.y + 0.2), impMat, 16);
        far.castShadow = false;
        const variant = { key, sp, vi, geo: g, radius, height: box.max.y, nearBark, nearLeaf, midBark, midLeaf, far, impMat, list: [] };
        this.variants.push(variant);
        this.byKey[key].push(variant);
      }
    }
    // bake impostors once the bark textures had a moment to arrive (and again a bit later)
    setTimeout(() => this.bakeImpostors(), 1500);
    setTimeout(() => this.bakeImpostors(), 8000);
  }

  bakeImpostors() {
    const r = this.renderer;
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    for (const v of this.variants) {
      if (!v.rt) {
        v.rt = new THREE.WebGLRenderTarget(256, 512, { samples: 0 });
        v.rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
        v.impMat.map = v.rt.texture; v.impMat.needsUpdate = true;
      }
      scene.clear();
      const bm = barkMaterial(v.sp.bark), lm = leafMaterial(v.sp.leaf).mat;
      const b = new THREE.Mesh(v.geo.bark, new THREE.MeshBasicMaterial({ map: bm.map, color: bm.map ? bm.color : '#5a4a3a' }));
      const l = new THREE.Mesh(v.geo.leaf, new THREE.MeshBasicMaterial({ map: lm.map, alphaTest: 0.45, side: THREE.DoubleSide, color: '#d8d8d8' }));
      scene.add(b, l);
      const w = v.radius * 2.1, h = v.height + 0.2;
      cam.left = -w / 2; cam.right = w / 2; cam.top = h - 0.2; cam.bottom = -0.2;
      cam.position.set(0, 0, 60); cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
      r.setRenderTarget(v.rt);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(scene, cam);
      b.material.dispose(); l.material.dispose();
    }
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
  }

  // ---------------------------------------------------------------- instances
  add(id, species, x, y, z, ry = 0, s = 1, seed = 0) {
    const list = this.byKey[species] || this.byKey.oak;
    const v = list[Math.abs(seed | 0) % list.length];
    this.remove(id);
    const it = { id, vi: v.vi, x, y, z, ry, s, hidden: false };
    this.items.set(id, it);
    const ck = this.cellKey(x, z);
    if (!this.grid.has(ck)) this.grid.set(ck, new Set());
    this.grid.get(ck).add(id);
    this.lodDirty = true;
    return it;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    this.items.delete(id);
    const set = this.grid.get(this.cellKey(it.x, it.z));
    if (set) set.delete(id);
    this.lodDirty = true;
  }

  setHidden(id, hidden) {
    const it = this.items.get(id);
    if (it && it.hidden !== hidden) { it.hidden = hidden; this.lodDirty = true; }
  }

  cellKey(x, z) { return Math.floor(x / 16) + ',' + Math.floor(z / 16); }

  // all visible trees within r of (x,z): used for collision and picking
  near(x, z, r, out = []) {
    const c0 = Math.floor((x - r) / 16), c1 = Math.floor((x + r) / 16), d0 = Math.floor((z - r) / 16), d1 = Math.floor((z + r) / 16);
    for (let j = d0; j <= d1; j++) for (let i = c0; i <= c1; i++) {
      const set = this.grid.get(i + ',' + j);
      if (!set) continue;
      for (const id of set) { const it = this.items.get(id); if (it && !it.hidden) out.push(it); }
    }
    return out;
  }

  trunkRadius(it) {
    const v = this.variants[it.vi];
    return v.sp.form === 'bush' ? 0 : v.sp.form === 'palm' ? 0.28 * it.s : Math.max(0.2, v.height * 0.03) * it.s;
  }

  // ray vs tree volumes (a cylinder hugging trunk + crown); returns {id, dist}
  pick(ray, maxDist = 400) {
    let best = null;
    const step = 8;
    const seen = new Set();
    for (let t = 0; t < maxDist; t += step) {
      tmpP.copy(ray.direction).multiplyScalar(t).add(ray.origin);
      for (const it of this.near(tmpP.x, tmpP.z, 12)) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        const v = this.variants[it.vi];
        const r = v.radius * it.s * 0.6, h = v.height * it.s;
        // closest approach of the ray to the tree's vertical axis
        const dx = it.x - ray.origin.x, dz = it.z - ray.origin.z;
        const dl = Math.hypot(ray.direction.x, ray.direction.z) || 1e-6;
        const along = (dx * ray.direction.x + dz * ray.direction.z) / (dl * dl);
        const px = ray.origin.x + ray.direction.x * along - it.x, pz = ray.origin.z + ray.direction.z * along - it.z;
        if (Math.hypot(px, pz) > r) continue;
        const py = ray.origin.y + ray.direction.y * along;
        if (py < it.y - 0.5 || py > it.y + h) continue;
        const dist = along * Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z);
        if (dist > 0 && (!best || dist < best.dist)) best = { id: it.id, dist };
      }
      if (best && best.dist < t) break;
    }
    return best;
  }

  // a standalone, non-instanced copy for build previews
  makePreview(species, seed = 0) {
    const list = this.byKey[species] || this.byKey.oak;
    const v = list[Math.abs(seed | 0) % list.length];
    const g = new THREE.Group();
    g.add(new THREE.Mesh(v.geo.bark, barkMaterial(v.sp.bark)), new THREE.Mesh(v.geo.leaf, leafMaterial(v.sp.leaf).mat));
    g.userData.height = v.height; g.userData.radius = v.radius;
    return g;
  }

  // ---------------------------------------------------------------- natural forests
  // Deterministic for the seed, so they need no network traffic. A player removing one stores a 'cut'
  // object on the server that hides it for everybody.
  populate() {
    const t = this.terrain;
    let n = 0;
    const step = 7;
    for (let z = -HALF + 4; z < HALF - 4; z += step) {
      for (let x = -HALF + 4; x < HALF - 4; x += step) {
        const jx = x + (hash2(x, z, 1) - 0.5) * step * 0.9, jz = z + (hash2(x, z, 2) - 0.5) * step * 0.9;
        const y = t.heightAt(jx, jz);
        if (y < 0.6 || y > 88) continue;
        const nrm = t.normalAt(jx, jz);
        if (nrm.y < 0.82) continue;
        const town = Math.hypot(jx - SPAWN.x, jz - SPAWN.z);
        const forest = t.forestMask(jx, jz);
        const r = hash2(x, z, 3);
        let species = null;
        if (y < 3.2) { if (r < 0.12 && town > 60) species = 'palm'; }
        else if (town < 120) { if (r < 0.006) species = 'oak'; }
        else if (r < forest * 0.7 + 0.03) {
          const r2 = hash2(x, z, 4);
          if (y > 42) species = r2 < 0.85 ? 'pine' : 'birch';
          else if (y > 22) species = r2 < 0.45 ? 'pine' : r2 < 0.7 ? 'birch' : 'oak';
          else species = r2 < 0.45 ? 'oak' : r2 < 0.7 ? 'maple' : r2 < 0.85 ? 'birch' : 'pine';
        } else if (r < forest * 0.7 + 0.09 && town > 70) species = 'bush';
        if (!species) continue;
        const s = species === 'bush' ? 0.8 + hash2(x, z, 6) * 0.7 : 0.75 + hash2(x, z, 6) * 0.5;
        this.add('n' + n, species, jx, y - 0.05, jz, hash2(x, z, 5) * Math.PI * 2, s, Math.floor(hash2(x, z, 7) * 3));
        n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- per frame
  update(dt, camera) {
    wind.uWindTime.value += dt;
    if (!this.lodDirty && camera.position.distanceToSquared(this.lastLod) < 64) return;
    this.lodDirty = false;
    this.lastLod.copy(camera.position);
    const cx = camera.position.x, cz = camera.position.z;
    const nd2 = this.nearDist * this.nearDist, sd2 = this.shadowDist * this.shadowDist;
    for (const v of this.variants) { v.nN = 0; v.nM = 0; v.nF = 0; }
    // make sure every buffer is big enough before writing
    const totals = new Array(this.variants.length).fill(0);
    for (const it of this.items.values()) totals[it.vi]++;
    for (const v of this.variants) {
      const need = totals[v.vi];
      for (const k of ['nearBark', 'nearLeaf', 'midBark', 'midLeaf', 'far']) {
        if (v[k].instanceMatrix.count < need) v[k] = this.grow(v[k], Math.max(need, v[k].instanceMatrix.count * 2));
      }
    }
    for (const it of this.items.values()) {
      if (it.hidden) continue;
      const v = this.variants[it.vi];
      const d2 = (it.x - cx) ** 2 + (it.z - cz) ** 2;
      tmpQ.setFromAxisAngle(UP, it.ry);
      tmpS.setScalar(it.s);
      tmpP.set(it.x, it.y, it.z);
      tmpM.compose(tmpP, tmpQ, tmpS);
      if (d2 < sd2) {
        tmpM.toArray(v.nearBark.instanceMatrix.array, v.nN * 16);
        tmpM.toArray(v.nearLeaf.instanceMatrix.array, v.nN * 16);
        v.nN++;
      } else if (d2 < nd2) {
        tmpM.toArray(v.midBark.instanceMatrix.array, v.nM * 16);
        tmpM.toArray(v.midLeaf.instanceMatrix.array, v.nM * 16);
        v.nM++;
      } else {
        // impostors always face the camera's general direction: rotate around y toward it
        tmpQ.setFromAxisAngle(UP, Math.atan2(cx - it.x, cz - it.z));
        tmpM.compose(tmpP, tmpQ, tmpS);
        tmpM.toArray(v.far.instanceMatrix.array, v.nF * 16);
        v.nF++;
      }
    }
    for (const v of this.variants) {
      v.nearBark.count = v.nN; v.nearLeaf.count = v.nN; v.midBark.count = v.nM; v.midLeaf.count = v.nM; v.far.count = v.nF;
      for (const k of ['nearBark', 'nearLeaf', 'midBark', 'midLeaf', 'far']) v[k].instanceMatrix.needsUpdate = true;
    }
  }

  grow(mesh, cap) {
    const m = new THREE.InstancedMesh(mesh.geometry, mesh.material, cap);
    m.count = 0; m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow; m.frustumCulled = false;
    m.customDepthMaterial = mesh.customDepthMaterial;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.remove(mesh); mesh.dispose();
    this.scene.add(m);
    return m;
  }
}
