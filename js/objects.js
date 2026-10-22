// Every placed object in the shared world. Records arrive from the network (or local edits) as
//   { id, owner, x, z, t: itemId, y, ry, s:[sx,sy,sz], m: material, c: '#tint', g: groupId, sd: seed, ref }
// and are drawn through instanced pools (one pool per item+finish), so ten thousand bricks-and-mortar
// pieces cost a few dozen draw calls. Also answers spatial questions: picking, colliders, lights.
import * as THREE from 'three';
import { ITEMS, partGeometry, itemSize, itemColliders, modelSizes, GROW_MS, learnFront } from './catalog.js';
import { buildMaterial, loadModel } from './assets.js';
import { HALF, CELL, N } from './config.js';

const CELLSZ = 8;
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);

// items that sit flat on the ground and should clear the grass under them
const GROUNDED = new Set(['floor', 'floor_small', 'foundation', 'road', 'road_plain', 'crossing', 'sidewalk', 'plaza', 'path', 'pool', 'planter', 'stairs_wide']);

class Pool {
  // lodDist: only instances within this many metres of the camera are drawn (furniture and props:
  // detailed photo-scanned models that nobody can see from across the island anyway)
  constructor(scene, lodDist = 0) {
    this.scene = scene;
    this.ids = [];
    this.index = new Map();
    this.cap = 0;
    this.matAttr = null;
    this.colAttr = null;
    this.meshes = [];
    this.parts = null;
    this.lodDist = lodDist;
    this.lodDirty = true;
    this.grow(16);
  }

  // copy the nearby instances (from the full list kept in master arrays) into the drawn buffers
  applyLod(cam) {
    if (!this.lodDist) return;
    const m = this.master, c = this.masterCol, d2 = this.lodDist * this.lodDist;
    let n = 0;
    for (let i = 0; i < this.ids.length; i++) {
      const x = m[i * 16 + 12], z = m[i * 16 + 14];
      if ((x - cam.x) ** 2 + (z - cam.z) ** 2 > d2) continue;
      this.matAttr.array.set(m.subarray(i * 16, i * 16 + 16), n * 16);
      this.colAttr.array.set(c.subarray(i * 3, i * 3 + 3), n * 3);
      n++;
    }
    this.drawCount = n;
    this.matAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
    for (const mesh of this.meshes) { mesh.count = n; mesh.boundingSphere = null; }
    this.lodDirty = false;
  }
  grow(cap) {
    const ma = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    const ca = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    ma.setUsage(THREE.DynamicDrawUsage); ca.setUsage(THREE.DynamicDrawUsage);
    if (this.matAttr) { ma.array.set(this.matAttr.array); ca.array.set(this.colAttr.array); }
    if (this.lodDist) {
      // the full list lives in master arrays; the attributes only hold what is near enough to draw
      const m = new Float32Array(cap * 16), c = new Float32Array(cap * 3).fill(1);
      if (this.master) { m.set(this.master); c.set(this.masterCol); }
      this.master = m; this.masterCol = c;
    }
    this.matAttr = ma; this.colAttr = ca; this.cap = cap;
    if (this.parts) this.setParts(this.parts);
  }
  // parts: [{ geometry, material, tint, shadow }]
  setParts(parts) {
    for (const m of this.meshes) { this.scene.remove(m); m.dispose(); }
    this.parts = parts;
    this.meshes = parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geometry, p.material, this.cap);
      m.instanceMatrix = this.matAttr;
      m.instanceColor = p.tint ? this.colAttr : null;
      m.count = this.lodDist ? this.drawCount || 0 : this.ids.length;
      m.castShadow = p.shadow !== false; m.receiveShadow = true;
      this.scene.add(m);
      return m;
    });
    this.lodDirty = true;
  }
  // where the per-instance data is written: the master list for distance-culled pools
  get mats() { return this.lodDist ? this.master : this.matAttr.array; }
  get cols() { return this.lodDist ? this.masterCol : this.colAttr.array; }
  upsert(id, matrix, color) {
    let i = this.index.get(id);
    if (i === undefined) {
      if (this.ids.length >= this.cap) this.grow(this.cap * 2);
      i = this.ids.length; this.ids.push(id); this.index.set(id, i);
    }
    matrix.toArray(this.mats, i * 16);
    (color || WHITE).toArray(this.cols, i * 3);
    this.touch();
  }
  remove(id) {
    const i = this.index.get(id);
    if (i === undefined) return;
    const last = this.ids.length - 1;
    if (i !== last) {
      const lid = this.ids[last];
      this.mats.copyWithin(i * 16, last * 16, last * 16 + 16);
      this.cols.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.ids[i] = lid; this.index.set(lid, i);
    }
    this.ids.pop(); this.index.delete(id);
    this.touch();
  }
  touch() {
    if (this.lodDist) { this.lodDirty = true; return; }
    this.matAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
    for (const m of this.meshes) { m.count = this.ids.length; m.boundingSphere = null; }
  }
}

export class WorldObjects {
  constructor(scene, terrain, trees) {
    this.scene = scene;
    this.terrain = terrain;
    this.trees = trees;
    this.recs = new Map();
    this.pools = new Map();
    this.grid = new Map();
    this.groups = new Map();      // groupId -> Set(ids)
    this.lights = new Set();      // ids of light-emitting objects
    this.cuts = new Map();        // natural tree id -> cut record id
    this.crops = new Set();       // ids of planted crops (they grow over time)
    this.nowFn = null;            // shared server clock, set by the game
    this.grassCount = new Uint16Array(N * N);
    this.grassMask = new Uint8Array(N * N).fill(255);
    this.grassTex = new THREE.DataTexture(this.grassMask, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    this.grassTex.magFilter = this.grassTex.minFilter = THREE.LinearFilter;
    this.grassTex.needsUpdate = true;
    this.onChange = null;
  }

  // ---------------------------------------------------------------- records
  // 0..1 how grown a crop is, from its planting time on the shared clock
  growth(rec) {
    const it = ITEMS[rec.t];
    if (!it || !it.crop) return 1;
    return Math.max(0, Math.min(1, ((this.nowFn ? this.nowFn() : Date.now()) - (rec.pt || 0)) / GROW_MS));
  }

  set(rec) {
    const it = ITEMS[rec.t];
    if (rec.t === 'cut') { this.removeRec(rec.id); this.recs.set(rec.id, rec); this.cuts.set(rec.ref, rec.id); this.trees.setHidden(rec.ref, true); return; }
    if (!it) return;
    this.removeRec(rec.id);
    rec.s = rec.s || [1, 1, 1];
    rec.ry = rec.ry || 0;
    this.recs.set(rec.id, rec);
    if (rec.g) { if (!this.groups.has(rec.g)) this.groups.set(rec.g, new Set()); this.groups.get(rec.g).add(rec.id); }
    if (it.crop) this.crops.add(rec.id);
    if (it.kind === 'tree') {
      this.trees.add(rec.id, it.species, rec.x, rec.y, rec.z, rec.ry, rec.s[0], rec.sd || 0);
    } else if (it.kind === 'vehicle') {
      if (this.vehicles) this.vehicles.add(rec);
    } else {
      // a ripe crop is drawn with its ripe model; growing ones are their sprout scaled up over time
      const gr = it.crop ? this.growth(rec) : 1;
      rec._ripe = gr >= 1;
      const drawn = it.crop && rec._ripe ? ITEMS[it.crop.ripe] : it;
      const pool = this.poolFor(drawn, rec.m || drawn.mat);
      rec._pool = pool;
      pool.upsert(rec.id, this.matrixOf(rec), rec.c ? new THREE.Color(rec.c) : null);
      if (it.light) this.lights.add(rec.id);
      if (GROUNDED.has(it.id)) this.markGrass(rec, 1);
    }
    this.index(rec, true);
    if (this.onChange) this.onChange(rec, 'set');
  }

  removeRec(id) {
    const rec = this.recs.get(id);
    if (!rec) return null;
    this.recs.delete(id);
    if (rec.t === 'cut') { this.cuts.delete(rec.ref); this.trees.setHidden(rec.ref, false); return rec; }
    const it = ITEMS[rec.t];
    if (rec.g && this.groups.has(rec.g)) { const g = this.groups.get(rec.g); g.delete(id); if (!g.size) this.groups.delete(rec.g); }
    if (it && it.kind === 'tree') this.trees.remove(id);
    else if (it && it.kind === 'vehicle') { if (this.vehicles) this.vehicles.remove(id); }
    else if (rec._pool) rec._pool.remove(id);
    this.lights.delete(id);
    this.crops.delete(id);
    if (it && GROUNDED.has(it.id)) this.markGrass(rec, -1);
    this.index(rec, false);
    if (this.onChange) this.onChange(rec, 'remove');
    return rec;
  }

  get(id) { return this.recs.get(id); }

  poolFor(it, matKey) {
    const key = it.id + '|' + (it.kind === 'part' ? matKey : '');
    let pool = this.pools.get(key);
    if (pool) return pool;
    // photo-scanned props are detailed: draw them only within 90 m (street lamps a little further),
    // scaled by the graphics preset
    const baseLod = it.kind === 'model' ? (it.cat === 'lighting' || it.cat === 'decor' ? 160 : 90) : 0;
    pool = new Pool(this.scene, baseLod * (this.propScale ?? 1));
    pool.baseLod = baseLod;
    this.pools.set(key, pool);
    if (it.kind === 'part') {
      const geos = partGeometry(it.id);
      pool.setParts(geos.map((g, slot) => g && {
        geometry: g,
        material: buildMaterial(slot === 0 && !it.fixedSlots ? matKey : it.slots[slot]),
        tint: slot === 0 && !it.fixedSlots,
        shadow: !(slot > 0 && ['glass', 'water', 'emissive'].includes(it.slots[slot])),
      }).filter(Boolean));
    } else {
      loadModel(it.model).then((m) => {
        if (!m) return;
        modelSizes.set(it.model, [m.size.x, m.size.y, m.size.z]);
        if (it.seat) learnFront(it.model, m.parts);
        pool.setParts(m.parts.map((p) => ({ geometry: p.geometry, material: p.material, tint: false, shadow: this.propShadows !== false })));
        // colliders and grid footprints change once the true size is known
        for (const id of pool.ids) { const r = this.recs.get(id); if (r) { this.index(r, false); this.index(r, true); } }
      });
    }
    return pool;
  }

  matrixOf(rec) {
    tmpQ.setFromAxisAngle(UP, rec.ry);
    const it = ITEMS[rec.t];
    const k = it && it.crop && !rec._ripe ? 0.25 + 0.75 * this.growth(rec) : 1;
    tmpS.set(rec.s[0] * k, rec.s[1] * k, rec.s[2] * k);
    tmpV.set(rec.x, rec.y, rec.z);
    return tmpM.compose(tmpV, tmpQ, tmpS);
  }

  // ---------------------------------------------------------------- spatial index
  footprint(rec) {
    const it = ITEMS[rec.t];
    const sz = itemSize(it);
    const r = Math.hypot(sz[0] * rec.s[0], sz[2] * rec.s[2]) / 2 + 0.5;
    return r;
  }
  index(rec, add) {
    if (rec.t === 'cut') return;
    const r = this.footprint(rec);
    const c0 = Math.floor((rec.x - r) / CELLSZ), c1 = Math.floor((rec.x + r) / CELLSZ);
    const d0 = Math.floor((rec.z - r) / CELLSZ), d1 = Math.floor((rec.z + r) / CELLSZ);
    for (let j = d0; j <= d1; j++) for (let i = c0; i <= c1; i++) {
      const k = i + ',' + j;
      let set = this.grid.get(k);
      if (add) { if (!set) this.grid.set(k, (set = new Set())); set.add(rec.id); }
      else if (set) { set.delete(rec.id); if (!set.size) this.grid.delete(k); }
    }
  }

  near(x, z, r, out = new Set()) {
    const c0 = Math.floor((x - r) / CELLSZ), c1 = Math.floor((x + r) / CELLSZ);
    const d0 = Math.floor((z - r) / CELLSZ), d1 = Math.floor((z + r) / CELLSZ);
    for (let j = d0; j <= d1; j++) for (let i = c0; i <= c1; i++) {
      const set = this.grid.get(i + ',' + j);
      if (set) for (const id of set) out.add(id);
    }
    return out;
  }

  // colliders near a point, each as { rec, col } in the record's local frame
  colliders(x, z, r) {
    const out = [];
    for (const id of this.near(x, z, r)) {
      const rec = this.recs.get(id);
      if (!rec || rec._driving) continue;   // a vehicle being driven is somewhere else right now
      const it = ITEMS[rec.t];
      if (!it || it.kind === 'tree') continue;
      for (const col of itemColliders(it)) out.push({ rec, col });
    }
    return out;
  }

  // local-space bounding box of a record (unscaled)
  localBox(rec, out = new THREE.Box3()) {
    const it = ITEMS[rec.t];
    if (it.kind === 'part') {
      const geos = partGeometry(it.id);
      out.makeEmpty();
      for (const g of geos) if (g) out.union(g.boundingBox);
      return out;
    }
    const s = itemSize(it);
    return out.set(new THREE.Vector3(-s[0] / 2, 0, -s[2] / 2), new THREE.Vector3(s[0] / 2, s[1], s[2] / 2));
  }

  // ray vs every object's oriented box; returns { id, dist, point } of the nearest hit
  pick(ray, maxDist = 350) {
    const seen = new Set();
    let best = null;
    const inv = new THREE.Matrix4(), lr = new THREE.Ray(), box = new THREE.Box3(), hit = new THREE.Vector3();
    for (let t = 0; t < maxDist; t += CELLSZ * 0.75) {
      tmpV.copy(ray.direction).multiplyScalar(t).add(ray.origin);
      for (const id of this.near(tmpV.x, tmpV.z, CELLSZ)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const rec = this.recs.get(id);
        if (!rec || rec.t === 'cut' || rec._driving || ITEMS[rec.t].kind === 'tree') continue;
        inv.copy(this.matrixOf(rec)).invert();
        lr.copy(ray).applyMatrix4(inv);
        this.localBox(rec, box).expandByScalar(0.02);
        if (lr.intersectBox(box, hit)) {
          // which face was hit, as a world-space normal (yaw only)
          const e = [hit.x - box.min.x, box.max.x - hit.x, hit.y - box.min.y, box.max.y - hit.y, hit.z - box.min.z, box.max.z - hit.z];
          const f = e.indexOf(Math.min(...e));
          const ln = new THREE.Vector3(f === 0 ? -1 : f === 1 ? 1 : 0, f === 2 ? -1 : f === 3 ? 1 : 0, f === 4 ? -1 : f === 5 ? 1 : 0);
          hit.applyMatrix4(this.matrixOf(rec));
          const d = hit.distanceTo(ray.origin);
          if (!best || d < best.dist) best = { id, dist: d, point: hit.clone(), normal: ln.applyAxisAngle(UP, rec.ry) };
        }
      }
      if (best && best.dist < t - CELLSZ) break;
    }
    return best;
  }

  // ---------------------------------------------------------------- grass clearing
  markGrass(rec, delta) {
    const it = ITEMS[rec.t];
    const sz = itemSize(it);
    const hx = (sz[0] * rec.s[0]) / 2 + 0.6, hz = (sz[2] * rec.s[2]) / 2 + 0.6;
    const c = Math.cos(rec.ry), s = Math.sin(rec.ry);
    const r = Math.hypot(hx, hz);
    const i0 = Math.max(0, Math.floor((rec.x - r + HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((rec.x + r + HALF) / CELL));
    const j0 = Math.max(0, Math.floor((rec.z - r + HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((rec.z + r + HALF) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = i * CELL - HALF - rec.x, dz = j * CELL - HALF - rec.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) > hx || Math.abs(lz) > hz) continue;
      const k = j * N + i;
      this.grassCount[k] = Math.max(0, this.grassCount[k] + delta);
      this.grassMask[k] = this.grassCount[k] ? 0 : 255;
    }
    this.grassTex.needsUpdate = true;
  }

  // distance-culled pools: refresh what is drawn when the camera has moved or something changed
  updateLod(cam) {
    const moved = !this.lodAt || (cam.x - this.lodAt.x) ** 2 + (cam.z - this.lodAt.z) ** 2 > 25;
    if (moved) this.lodAt = { x: cam.x, z: cam.z };
    for (const pool of this.pools.values()) if (pool.lodDist && (moved || pool.lodDirty)) pool.applyLod(this.lodAt);
  }

  // graphics preset: how far props are drawn (x their base distance) and whether they cast shadows
  setPropQuality(scale, shadows) {
    this.propScale = scale; this.propShadows = shadows;
    for (const pool of this.pools.values()) if (pool.baseLod) { pool.lodDist = pool.baseLod * scale; pool.lodDirty = true; for (const m of pool.meshes) m.castShadow = shadows; }
  }

  // re-pose growing crops a few times a minute; swap to the ripe model when they're ready
  updateCrops(dt) {
    this.cropTimer = (this.cropTimer || 0) - dt;
    if (this.cropTimer > 0 || !this.crops.size) return;
    this.cropTimer = 3;
    for (const id of this.crops) {
      const r = this.recs.get(id);
      if (!r) continue;
      const ripe = this.growth(r) >= 1;
      if (ripe !== r._ripe) this.set({ ...r });
      else if (!ripe && r._pool) r._pool.upsert(id, this.matrixOf(r), r.c ? new THREE.Color(r.c) : null);
    }
  }

  // ---------------------------------------------------------------- bulk helpers
  groupIds(g) { return g && this.groups.has(g) ? [...this.groups.get(g)] : []; }
  count() { return this.recs.size; }
}
