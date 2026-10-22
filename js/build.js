// The creative tools. Each mode owns the right-hand panel and the left mouse button:
//   explore  - walk around; click people to see their card
//   build    - pick an item from the catalogue, see a live preview, click to place (snaps to the 4 m grid)
//   edit     - click anything to select it: move, rotate, recolour, resize, duplicate, delete
//   house    - drag a footprint, choose a style, get a whole furnished house made of ordinary parts
//   terrain  - raise / lower / flatten / smooth / paint the ground
//   nature   - paint forests, bushes and rocks, or erase them
//   land     - claim plots so nobody else can build on them
import * as THREE from 'three';
import { ITEMS, CATEGORIES, partGeometry, itemSize } from './catalog.js';
import { buildMaterial, loadModel, MATERIALS } from './assets.js';
import { generateHouse, STYLES } from './houses.js';
import { LAYERS } from './terrain.js';
import { SPECIES } from './trees.js';
import { PLOT, plotKey, plotOrigin, HALF, SEA, inTown } from './config.js';

export const MODES = [
  { id: 'explore', label: 'Explore', key: '1', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.2 5.8-2.1 6.3-6.3 2.1 2.1-6.3z' },
  { id: 'build', label: 'Build', key: '2', icon: 'M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6' },
  { id: 'edit', label: 'Select & edit', key: '3', icon: 'M5 3l14 8-6 2-2 6z' },
  { id: 'house', label: 'House generator', key: '4', icon: 'M3 11l9-7 9 7M6 9v11h12V9M10 20v-5h4v5' },
  { id: 'terrain', label: 'Landscape', key: '5', icon: 'M2 20l6-9 4 5 3-4 7 8z' },
  { id: 'nature', label: 'Nature', key: '6', icon: 'M12 3c-4 4-6 7-6 10a6 6 0 0 0 12 0c0-3-2-6-6-10zM12 22v-6' },
  { id: 'land', label: 'Land & plots', key: '7', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
];

const UP = new THREE.Vector3(0, 1, 0);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const swatchUrl = (k) => (MATERIALS[k]?.ph ? `https://cdn.polyhaven.com/asset_img/thumbs/${MATERIALS[k].ph}.png?width=64&height=64` : '');

export class BuildTools {
  constructor(game) {
    this.g = game;
    this.mode = 'explore';
    this.cat = 'structure';
    this.item = null;
    this.mat = null;
    this.tint = null;
    this.ry = 0;
    this.lift = 0;
    this.scale = [1, 1, 1];
    this.snapOn = true;
    this.mouse = null;
    this.ghost = null;
    this.ghostKey = '';
    this.sel = null;            // selected record id (or natural tree id)
    this.carry = null;          // { ids, anchor, offsets } while moving a selection
    this.undoStack = [];
    this.brush = { tool: 'raise', r: 7, s: 0.5, layer: 0 };
    this.nature = { set: new Set(['oak', 'maple', 'birch']), density: 0.5, r: 10, erase: false };
    this.house = { style: 'cottage', floors: 1, roof: '', furnish: true, fp: null };
    this.landSel = null;
    this.multi = new Set();       // Shift+click multi-selection (record ids)
    this.extraOutlines = [];
    this.query = '';
    this.favs = new Set(game.store.get('favs', []));
    this.thumbs = new Map();
    this.thumbQueue = [];

    const lineMat = (c) => new THREE.LineBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.9 });
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), lineMat(0x5ad1ff));
    this.outline.visible = false; this.outline.renderOrder = 10;
    game.scene.add(this.outline);
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3)), lineMat(0xffffff));
    this.ring.visible = false; this.ring.renderOrder = 10; this.ring.frustumCulled = false;
    game.scene.add(this.ring);
    this.plotLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: true }));
    this.plotLines.visible = false; this.plotLines.frustumCulled = false;
    game.scene.add(this.plotLines);
    this.plotFill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
    this.plotFill.visible = false; this.plotFill.frustumCulled = false;
    game.scene.add(this.plotFill);

    this.bindPointer();
    this.bindKeys();
  }

  // ---------------------------------------------------------------- modes
  // true while R/Q/E belong to the tool (rotating what you're placing or have selected)
  usesRotateKeys() { return (this.mode === 'build' && !!this.item) || !!this.carry || (this.mode === 'edit' && !!this.sel); }

  setMode(m) {
    if (this.carry) this.cancelCarry();
    const p = this.g.player;
    // the house tool works from an overhead camera; give the avatar view back when leaving it
    if (m === 'house' && !p.freeCam) {
      const fwd = new THREE.Vector3(-Math.sin(p.camYaw), 0, -Math.cos(p.camYaw));
      const at = p.pos.clone().addScaledVector(fwd, 14);
      at.y = this.g.terrain.heightAt(at.x, at.z) + 1;
      p.setFreeCam(true, { at, dist: 38, pitch: -0.7 });
      this.autoFreeCam = true;
    } else if (this.mode === 'house' && m !== 'house' && this.autoFreeCam && p.freeCam) p.setFreeCam(false);
    if (m !== 'house') this.autoFreeCam = false;
    this.mode = m;
    this.clearGhost();
    this.outline.visible = false;
    this.ring.visible = false;
    this.painting = false;
    if (m !== 'edit') this.sel = null;
    if (m !== 'house') this.house.fp = null;
    this.plotLines.visible = this.plotFill.visible = m === 'land';
    if (m === 'land') this.rebuildPlotOverlay(true);
    this.g.ui.onMode(m);
    this.renderPanel();
    // open the house tool with a house already outlined on free ground in view, ready to build
    if (m === 'house' && !this.house.fp && this.g.ready) {
      const at = p.freeCam ? (p.focusGoal || p.focus) : p.pos;
      this.proposeFootprint(at.x, at.z);
    }
  }

  panel() { return document.getElementById('tool-panel'); }

  // ---------------------------------------------------------------- input
  bindPointer() {
    const el = this.g.renderer.domElement;
    el.addEventListener('pointermove', (e) => { this.mouse = { clientX: e.clientX, clientY: e.clientY }; });
    el.addEventListener('pointerleave', () => { this.mouse = null; });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.altKey) return;
      this.down = { x: e.clientX, y: e.clientY };
      this.mouse = { clientX: e.clientX, clientY: e.clientY };
      if (this.mode === 'terrain' || this.mode === 'nature') { this.painting = true; this.paintClock = 1; this.strokeWarned = false; this.flattenY = null; }
      // walls, fences and railings: press and drag to draw a whole run of them
      if (this.mode === 'build' && this.item && ITEMS[this.item].snap === 'edge') {
        const pl = this.placementFor(this.g.rayFromEvent(e), ITEMS[this.item], this.ry, this.scale);
        if (pl) this.line = { start: pl, recs: [] };
      }
      if (this.mode === 'house') {
        const p = this.g.terrain.raycast(this.g.rayFromEvent(e));
        if (p) this.house.drag = { a: p.clone(), b: p.clone() };
      }
    });
    addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      this.painting = false;
      if (this.mode === 'house' && this.house.drag) {
        this.finishFootprint(moved < 6);
        return;
      }
      const line = this.line;
      this.line = null;
      if (line && line.recs.length > 1) { this.placeLine(line); return; }
      if (moved < 6 && e.target === el) this.click(e);
    });
  }

  // the run of wall pieces from where the drag started to the cursor, along whichever axis is longer
  lineRecs(start, ray) {
    const it = ITEMS[this.item];
    const pl = this.placementFor(ray, it, this.ry, this.scale);
    if (!pl) return [];
    const dx = pl.x - start.x, dz = pl.z - start.z;
    const alongX = Math.abs(dx) >= Math.abs(dz);
    const len = itemSize(it)[0] * this.scale[0];
    const ry = alongX ? 0 : Math.PI / 2;
    // re-snap the start for the chosen direction so pieces join edge to edge
    const [sx, sz] = this.snapXZ(it, start.x, start.z, ry, this.scale);
    const n = Math.min(40, Math.round(Math.abs(alongX ? pl.x - sx : pl.z - sz) / len) + 1);
    const sgn = Math.sign(alongX ? dx : dz) || 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = alongX ? sx + sgn * i * len : sx, z = alongX ? sz : sz + sgn * i * len;
      out.push({ t: it.id, x, z, y: this.surfaceY(x, z, start.y - this.lift + 0.05) + this.lift, ry, s: [...this.scale], m: this.mat || it.mat, c: this.tint || undefined });
    }
    return out;
  }

  placeLine(line) {
    const recs = line.recs.filter((r) => this.g.canBuild(r.x, r.z));
    if (recs.length < line.recs.length) this.deny(line.recs.find((r) => !this.g.canBuild(r.x, r.z)).x, line.recs.find((r) => !this.g.canBuild(r.x, r.z)).z);
    if (!recs.length) return;
    this.commit(recs.map((r) => ({ ...r, id: this.g.newId() })));
    this.g.ui.sound('place');
    this.g.event('place');
    this.clearGhost();
  }

  bindKeys() {
    addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select') || this.g.ui.isTyping()) return;
      const k = e.code;
      if ((e.ctrlKey || e.metaKey) && k === 'KeyZ') { e.preventDefault(); this.undo(); return; }
      if (!e.ctrlKey && !e.metaKey && /^Digit[1-7]$/.test(k)) { this.setMode(MODES[+k.slice(5) - 1].id); return; }
      if (k === 'Escape') {
        if (this.carry) this.cancelCarry();
        else if (this.mode === 'build' && this.item) { this.item = null; this.clearGhost(); this.renderPanel(); }
        else if (this.sel) this.select(null);
        else if (this.house.fp) { this.house.fp = null; this.clearGhost(); this.renderPanel(); }
        else if (this.g.player.freeCam) this.g.player.setFreeCam(false);
        else this.setMode('explore');
        return;
      }
      const placing = (this.mode === 'build' && this.item) || this.carry;
      const target = placing ? 'tool' : this.mode === 'edit' && this.sel ? 'sel' : null;
      if (!target) return;
      const step = e.shiftKey ? -1 : 1;
      if (k === 'KeyR') this.rotate(target, step * Math.PI / 2);
      else if (k === 'KeyQ') this.rotate(target, -Math.PI / 12);
      else if (k === 'KeyE') this.rotate(target, Math.PI / 12);
      else if (k === 'PageUp' || k === 'BracketRight') this.raise(target, e.shiftKey ? 1 : 0.25);
      else if (k === 'PageDown' || k === 'BracketLeft') this.raise(target, e.shiftKey ? -1 : -0.25);
      else if (k === 'KeyG' && target === 'tool') { this.snapOn = !this.snapOn; this.g.ui.toast(this.snapOn ? 'Grid snapping on' : 'Grid snapping off (free placement)'); this.renderPanel(); }
      else if (target === 'sel' && (k === 'Delete' || k === 'Backspace')) this.deleteSelection();
      else if (target === 'sel' && k === 'KeyG') this.startCarry();
      else if (target === 'sel' && (e.ctrlKey || e.metaKey) && k === 'KeyD') { e.preventDefault(); this.duplicate(); }
    });
  }

  rotate(target, a) {
    if (target === 'tool' && this.carry) { this.carry.ry = norm((this.carry.ry || 0) + a); return; }
    if (target === 'tool') { this.ry = norm(this.ry + a); this.renderPanel(true); return; }
    const r = this.g.objects.get(this.sel);
    if (!r || !this.g.canModify(r)) return;
    this.commit([{ ...r, ry: norm(r.ry + a) }]);
  }
  raise(target, d) {
    if (target === 'tool') { this.lift = Math.round((this.lift + d) * 100) / 100; this.renderPanel(true); return; }
    const r = this.g.objects.get(this.sel);
    if (!r || !this.g.canModify(r)) return;
    this.commit([{ ...r, y: r.y + d }]);
  }

  click(e) {
    const ray = this.g.rayFromEvent(e);
    switch (this.mode) {
      case 'explore': {
        const sid = this.pickPlayer(ray);
        if (sid) this.g.ui.showPlayerCard(sid);
        break;
      }
      case 'build': this.place(ray); break;
      case 'edit':
        if (this.carry) this.dropCarry(ray);
        else if (e.shiftKey) this.toggleMulti(this.pickAny(ray));
        else this.select(this.pickAny(ray));
        break;
      case 'land': {
        const p = this.g.terrain.raycast(ray);
        if (p) { this.landSel = plotKey(p.x, p.z); this.rebuildPlotOverlay(true); this.renderPanel(); }
        break;
      }
    }
  }

  pickPlayer(ray) {
    let best = null, bd = 1e9;
    for (const pl of this.g.players.values()) {
      const c = pl.pos.clone().add(new THREE.Vector3(0, 1, 0));
      const d = ray.distanceToPoint(c);
      const along = c.clone().sub(ray.origin).dot(ray.direction);
      if (d < 0.7 && along > 0 && along < bd) { bd = along; best = pl.sid; }
    }
    return best;
  }

  pickAny(ray) {
    const o = this.g.objects.pick(ray, 400);
    const t = this.g.trees.pick(ray, 400);
    const terr = this.g.terrain.raycast(ray);
    const td = terr ? terr.distanceTo(ray.origin) : Infinity;
    let best = null;
    if (o && o.dist < td + 0.5) best = o;
    if (t && t.dist < td + 1 && (!best || t.dist < best.dist)) best = t;
    return best ? best.id : null;
  }

  // ---------------------------------------------------------------- placement
  surfaceY(x, z, maxY) { return this.g.player.groundAt(x, z, maxY, 0); }

  placementFor(ray, it, ry, scale) {
    const o = this.g.objects.pick(ray, 400);
    const terr = this.g.terrain.raycast(ray, 2500);
    const td = terr ? terr.distanceTo(ray.origin) : Infinity;
    let p, n = null;
    if (o && o.dist < td) { p = o.point.clone(); n = o.normal; }
    else if (terr) p = terr.clone();
    else return null;
    const sz = itemSize(it);
    if (it.wall && n && Math.abs(n.y) < 0.5) {
      return { x: p.x + n.x * 0.03, y: p.y - (sz[1] * scale[1]) / 2 + this.lift, z: p.z + n.z * 0.03, ry: Math.atan2(n.x, n.z), surf: p.y };
    }
    let [x, z] = this.snapXZ(it, p.x, p.z, ry, scale);
    let y;
    if (it.hang) y = n && n.y < -0.5 ? p.y - sz[1] * scale[1] : this.surfaceY(x, z, p.y + 0.05) + 2.7;
    else y = this.surfaceY(x, z, p.y + 0.05);
    if (it.floats) y = Math.max(y, SEA - 0.5);
    return { x, y: y + this.lift, z, ry };
  }

  snapXZ(it, x, z, ry, scale = this.scale) {
    if (!this.snapOn || it.snap === 'free') return [Math.round(x * 20) / 20, Math.round(z * 20) / 20];
    const q90 = Math.round(ry / (Math.PI / 2));
    if (Math.abs(ry - q90 * Math.PI / 2) > 0.01 || it.snap === 'grid1') return [Math.round(x * 2) / 2, Math.round(z * 2) / 2];
    const sz = itemSize(it);
    let lx = sz[0] * scale[0], lz = sz[2] * scale[2];
    if (q90 % 2) [lx, lz] = [lz, lx];
    const fit = (v, L, gr) => (Math.round(L / gr) % 2 === 1 ? Math.floor(v / gr) * gr + gr / 2 : Math.round(v / gr) * gr);
    if (it.snap === 'grid4') return [fit(x, lx, 4), fit(z, lz, 4)];
    if (it.snap === 'grid2') return [fit(x, lx, 2), fit(z, lz, 2)];
    // edge: centred on a grid line, spanning one cell along it
    const L = Math.max(lx, lz), gr = L >= 3.9 ? 4 : 2;
    return lx >= lz ? [fit(x, L, gr), Math.round(z / gr) * gr] : [Math.round(x / gr) * gr, fit(z, L, gr)];
  }

  place(ray) {
    if (!this.item) { this.g.ui.toast('Pick something from the catalogue first'); return; }
    const it = ITEMS[this.item];
    const pl = this.placementFor(ray, it, this.ry, this.scale);
    if (!pl) return;
    if (!this.g.canBuild(pl.x, pl.z)) { this.deny(pl.x, pl.z); return; }
    const rec = { id: this.g.newId(), t: it.id, x: pl.x, y: pl.y, z: pl.z, ry: pl.ry ?? this.ry, s: [...this.scale] };
    if (it.kind === 'part') rec.m = this.mat || it.mat;
    if (this.tint) rec.c = this.tint;
    if (it.kind === 'tree') { rec.sd = Math.floor(Math.random() * 3); rec.ry = Math.random() * Math.PI * 2; }
    if (it.crop) { rec.pt = this.g.now(); rec.ry = Math.random() * Math.PI * 2; }
    this.commit([rec]);
    this.g.ui.sound('place');
    this.g.event(it.crop ? 'plant' : 'place');
  }

  deny(x, z) {
    if (inTown(x, z)) { this.g.ui.toast('This is the town square - it belongs to everyone. Build outside the town.', 'warn'); return; }
    const p = this.g.plotAt(x, z);
    this.g.ui.toast(p ? `This plot belongs to ${this.g.ownerName(p.owner)}${p.name ? ' (' + p.name + ')' : ''}` : 'You cannot build here', 'warn');
  }

  // apply a batch of record writes (new or changed), remembering how to undo it
  commit(recs, prevs) {
    const undo = recs.map((r, i) => ({ id: r.id, prev: prevs ? (prevs[i] ? { ...prevs[i] } : null) : this.g.objects.get(r.id) ? { ...this.g.objects.get(r.id) } : null }));
    for (const r of recs) this.g.putObject(r);
    this.undoStack.push(undo);
    if (this.undoStack.length > 60) this.undoStack.shift();
    if (this.sel) this.renderPanel(true);
  }
  removeMany(ids) {
    const undo = [];
    for (const id of ids) {
      const r = this.g.objects.get(id);
      if (!r || !this.g.canModify(r)) continue;
      undo.push({ id, prev: { ...r } });
      this.g.deleteObject(id);
    }
    if (undo.length) this.undoStack.push(undo);
    return undo.length;
  }
  undo() {
    const step = this.undoStack.pop();
    if (!step) { this.g.ui.toast('Nothing to undo'); return; }
    for (const u of step.reverse()) {
      if (u.prev) { const { _pool, ...r } = u.prev; this.g.putObject(r); }
      else this.g.deleteObject(u.id);
    }
    this.g.ui.toast('Undone');
    if (this.sel && !this.g.objects.get(this.sel) && !this.isNatural(this.sel)) this.select(null);
  }

  // ---------------------------------------------------------------- ghosts
  clearGhost() {
    if (this.ghost) { this.g.scene.remove(this.ghost); this.ghost.traverse((o) => { if (o.isInstancedMesh) o.dispose(); }); }
    if (this.lineGhost) { this.g.scene.remove(this.lineGhost); this.lineGhost = null; }
    this.ghost = null; this.ghostKey = '';
    this.outline.visible = false;
    for (const o of this.extraOutlines || []) o.visible = false;
  }

  // a single object's look (instanced with one instance so tints work with the shared materials)
  ghostObject(rec) {
    const it = ITEMS[rec.t];
    const g = new THREE.Group();
    if (it.kind === 'part') {
      const geos = partGeometry(it.id);
      geos.forEach((geo, slot) => {
        if (!geo) return;
        const m = new THREE.InstancedMesh(geo, buildMaterial(slot === 0 ? rec.m || it.mat : it.slots[slot]), 1);
        m.setMatrixAt(0, new THREE.Matrix4());
        if (slot === 0 && rec.c) m.setColorAt(0, new THREE.Color(rec.c));
        m.castShadow = true;
        g.add(m);
      });
    } else if (it.kind === 'model') {
      loadModel(it.model).then((md) => { if (md) for (const p of md.parts) { const m = new THREE.Mesh(p.geometry, p.material); m.castShadow = true; g.add(m); } });
    } else if (it.kind === 'tree') {
      g.add(this.g.trees.makePreview(it.species, rec.sd || 0));
    }
    return g;
  }

  setTransform(obj, r) {
    obj.position.set(r.x, r.y, r.z);
    obj.rotation.set(0, r.ry || 0, 0);
    const s = r.s || [1, 1, 1];
    obj.scale.set(s[0], s[1], s[2]);
  }

  showOutline(r, ok) {
    const box = this.g.objects.localBox({ ...r, s: r.s || [1, 1, 1] }, new THREE.Box3());
    if (ITEMS[r.t]?.kind === 'tree') box.set(new THREE.Vector3(-1.5, 0, -1.5), new THREE.Vector3(1.5, 8, 1.5));
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const s = r.s || [1, 1, 1];
    this.outline.position.set(c.x * s[0], c.y * s[1], c.z * s[2]).applyAxisAngle(UP, r.ry || 0).add(new THREE.Vector3(r.x, r.y, r.z));
    this.outline.rotation.set(0, r.ry || 0, 0);
    this.outline.scale.set(Math.max(0.05, size.x * s[0]), Math.max(0.05, size.y * s[1]), Math.max(0.05, size.z * s[2]));
    this.outline.material.color.set(ok ? 0x5ad1ff : 0xff6a5a);
    this.outline.visible = true;
  }

  // ---------------------------------------------------------------- selection
  isNatural(id) { return /^n\d+$/.test(id); }

  select(id) {
    this.sel = id;
    this.multi.clear();
    for (const o of this.extraOutlines) o.visible = false;
    if (!id) this.outline.visible = false;
    this.renderPanel();
  }

  // Shift+click: add or remove a piece from a multi-selection
  toggleMulti(id) {
    if (!id || this.isNatural(id) || !this.g.objects.get(id)) return;
    if (!this.multi.size && this.sel && !this.isNatural(this.sel)) this.multi.add(this.sel);
    if (this.multi.has(id)) this.multi.delete(id); else this.multi.add(id);
    this.sel = this.multi.size ? [...this.multi][this.multi.size - 1] : null;
    if (this.multi.size === 1) { this.sel = [...this.multi][0]; this.multi.clear(); }
    this.renderPanel();
  }

  // ids the selection acts on: the multi-selection, or the single selected piece
  selectedIds() { return this.multi.size ? [...this.multi] : this.sel && !this.isNatural(this.sel) ? [this.sel] : []; }

  deleteSelection() {
    if (this.multi.size) {
      const n = this.removeMany([...this.multi]);
      this.select(null);
      this.g.ui.toast(`Removed ${n} pieces (Ctrl+Z brings them back)`);
      return;
    }
    const id = this.sel;
    if (!id) return;
    if (this.isNatural(id)) { this.cutTree(id); this.select(null); return; }
    const r = this.g.objects.get(id);
    if (!r) return;
    if (!this.g.canModify(r)) { this.g.ui.toast(`That belongs to ${this.g.ownerName(r.owner)}`, 'warn'); return; }
    this.removeMany([id]);
    this.select(null);
    this.g.ui.sound('remove');
  }

  cutTree(id) {
    const t = this.g.trees.items.get(id);
    if (!t) return;
    if (!this.g.canBuild(t.x, t.z)) { this.deny(t.x, t.z); return; }
    this.commit([{ id: this.g.newId(), t: 'cut', ref: id, x: t.x, y: t.y, z: t.z }]);
  }

  duplicate() {
    const r = this.g.objects.get(this.sel);
    if (!r) return;
    this.item = r.t; this.mat = r.m || null; this.tint = r.c || null; this.ry = r.ry; this.scale = [...(r.s || [1, 1, 1])]; this.lift = 0;
    this.cat = ITEMS[r.t].cat;
    this.setMode('build');
    this.g.ui.toast('Copied - click to place copies');
  }

  startCarry(group) {
    const r = this.g.objects.get(this.sel);
    if (!r || !this.g.canModify(r)) return;
    let ids = group && r.g ? this.g.objects.groupIds(r.g) : this.multi.size ? [...this.multi] : [r.id];
    ids = ids.filter((id) => this.g.canModify(this.g.objects.get(id)));
    this.carry = { ids, anchor: { ...r }, recs: ids.map((id) => ({ ...this.g.objects.get(id) })), ry: 0 };
    this.g.ui.toast(ids.length > 1 ? `Moving ${ids.length} pieces - click to drop, R turns them, Esc cancels` : 'Moving - click to drop, R/Q/E rotate, Esc cancels');
  }
  cancelCarry() {
    const c = this.carry;
    this.carry = null;
    // the originals were only hidden locally while carried; put them back as they were
    if (c && c.hidden && !c.isNew) for (const r of c.recs) this.g.objects.set({ ...r });
    this.clearGhost();
    this.renderPanel();
  }

  // ---------------------------------------------------------------- blueprints
  // A blueprint is a saved set of pieces relative to its first piece. They live in this browser and can
  // be shared as a text code that anyone can paste in.
  blueprints() { return this.g.store.get('blueprints', []); }

  saveBlueprint(ids, name) {
    const recs = ids.map((id) => this.g.objects.get(id)).filter((r) => r && r.t !== 'cut');
    if (!recs.length) return;
    const a = recs[0];
    const items = recs.map((r) => {
      const o = { t: r.t, dx: +(r.x - a.x).toFixed(3), dy: +(r.y - a.y).toFixed(3), dz: +(r.z - a.z).toFixed(3), ry: +(r.ry || 0).toFixed(4) };
      if (r.s && r.s.some((v) => v !== 1)) o.s = r.s;
      for (const k of ['m', 'c', 'sd', 'open']) if (r[k] !== undefined) o[k] = r[k];
      return o;
    });
    const list = this.blueprints();
    list.unshift({ name: name || `Blueprint ${list.length + 1}`, items, at: Date.now() });
    this.g.store.set('blueprints', list.slice(0, 40));
    this.g.ui.toast(`Saved "${list[0].name}" (${items.length} pieces). Find it in Build > Blueprints.`);
  }

  bpCode(bp) { return 'RELIVE1:' + btoa(unescape(encodeURIComponent(JSON.stringify(bp)))); }
  importBlueprint(code) {
    try {
      const bp = JSON.parse(decodeURIComponent(escape(atob(code.trim().replace(/^RELIVE1:/, '')))));
      if (!Array.isArray(bp.items) || !bp.items.every((i) => ITEMS[i.t])) throw new Error('bad');
      const list = this.blueprints();
      list.unshift({ ...bp, at: Date.now() });
      this.g.store.set('blueprints', list.slice(0, 40));
      this.g.ui.toast(`Imported "${bp.name}"`);
      this.renderPanel();
    } catch { this.g.ui.toast('That code is not a ReLive blueprint', 'warn'); }
  }

  // pick a blueprint up like a carried build: new pieces follow the cursor until you click to drop them
  placeBlueprint(i) {
    const bp = this.blueprints()[i];
    if (!bp) return;
    const gid = 'b' + this.g.newId();
    const recs = bp.items.map((o) => ({ id: this.g.newId(), t: o.t, x: o.dx, y: o.dy, z: o.dz, ry: o.ry, s: o.s || [1, 1, 1], m: o.m, c: o.c, sd: o.sd, open: o.open, g: bp.items.length > 1 ? gid : undefined, pt: ITEMS[o.t].crop ? this.g.now() : undefined }));
    this.setMode('edit');
    this.carry = { ids: [], anchor: { ...recs[0] }, recs, ry: 0, isNew: true };
    this.g.ui.toast(`Placing "${bp.name}" - click to drop, R turns it, Esc cancels`);
    this.renderPanel();
  }
  dropCarry(ray) {
    const c = this.carry;
    const it = ITEMS[c.anchor.t];
    const pl = this.placementFor(ray, it, c.anchor.ry, c.anchor.s || [1, 1, 1]);
    if (!pl) return;
    const out = this.carryTransform(c, pl);
    for (const r of out) if (!this.g.canBuild(r.x, r.z)) { this.deny(r.x, r.z); return; }
    this.carry = null;
    this.clearGhost();
    this.commit(out.map(({ _pool, ...r }) => r), c.isNew ? out.map(() => null) : c.recs);
    if (c.isNew) { this.g.ui.sound('place'); this.g.event('place'); }
    this.sel = out[0].id;
    this.multi.clear();
    if (out.length > 1 && !c.isNew) for (const r of out) this.multi.add(r.id);
    this.renderPanel();
  }
  // move (and spin, for groups, about the anchor) every carried record to follow the anchor's new spot
  carryTransform(c, pl) {
    const a = c.anchor, spin = c.ry || 0;
    const dy = pl.y - a.y;
    if (c.recs.length === 1) return [{ ...c.recs[0], x: pl.x, y: pl.y, z: pl.z, ry: norm((pl.ry ?? a.ry) + spin) }];
    const cs = Math.cos(spin), sn = Math.sin(spin);
    return c.recs.map((r) => {
      const lx = r.x - a.x, lz = r.z - a.z;
      return { ...r, x: pl.x + lx * cs + lz * sn, z: pl.z - lx * sn + lz * cs, y: r.y + dy, ry: norm(r.ry + spin) };
    });
  }

  onRemoteChange(id) {
    if (id === this.sel) {
      if (!this.g.objects.get(id)) this.select(null);
      else this.renderPanel(true);
    }
  }

  // ---------------------------------------------------------------- house
  finishFootprint(isClick) {
    const d = this.house.drag;
    this.house.drag = null;
    if (isClick) { this.proposeFootprint(d.a.x, d.a.z, false); return; }
    let x0 = Math.floor(Math.min(d.a.x, d.b.x) / 4) * 4, x1 = Math.ceil(Math.max(d.a.x, d.b.x) / 4) * 4;
    let z0 = Math.floor(Math.min(d.a.z, d.b.z) / 4) * 4, z1 = Math.ceil(Math.max(d.a.z, d.b.z) / 4) * 4;
    if (x1 - x0 < 8) x1 = x0 + 8;
    if (z1 - z0 < 8) z1 = z0 + 8;
    x1 = Math.min(x1, x0 + 24); z1 = Math.min(z1, z0 + 24);
    this.setFootprint(x0, x1, z0, z1);
  }

  // A 12 × 8 m footprint centred near (x, z). With `findFree`, step outward until it lands on empty
  // ground, so the outline that appears when the tool opens never sits on top of an existing build.
  proposeFootprint(x, z, findFree = true) {
    const at = (cx, cz) => ({ x0: cx - 6, x1: cx + 6, z0: cz - 4, z1: cz + 4 });
    const cx0 = Math.round(x / 4) * 4, cz0 = Math.round(z / 4) * 4;
    let f = at(cx0, cz0);
    if (findFree) {
      search: for (let ring = 1; ring <= 6 && this.footprintBlocked(f); ring++) {
        for (let k = 0; k < ring * 8; k++) {
          const a = (k / (ring * 8)) * Math.PI * 2;
          const c = at(cx0 + Math.round((Math.cos(a) * ring * 16) / 4) * 4, cz0 + Math.round((Math.sin(a) * ring * 12) / 4) * 4);
          if (!this.footprintBlocked(c)) { f = c; break search; }
        }
      }
    }
    this.setFootprint(f.x0, f.x1, f.z0, f.z1);
  }

  // something already built (not trees or plants) inside the footprint, or land we may not build on
  footprintBlocked(f) {
    for (const [x, z] of [[f.x0 + 0.1, f.z0 + 0.1], [f.x1 - 0.1, f.z0 + 0.1], [f.x0 + 0.1, f.z1 - 0.1], [f.x1 - 0.1, f.z1 - 0.1]]) if (!this.g.canBuild(x, z)) return true;
    const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
    for (const id of this.g.objects.near(cx, cz, Math.hypot(f.x1 - f.x0, f.z1 - f.z0) / 2 + 2)) {
      const r = this.g.objects.get(id), it = r && ITEMS[r.t];
      if (!it || it.kind === 'tree' || it.cat === 'nature') continue;
      if (r.x > f.x0 - 1 && r.x < f.x1 + 1 && r.z > f.z0 - 1 && r.z < f.z1 + 1) return true;
    }
    return false;
  }

  setFootprint(x0, x1, z0, z1) {
    // face the door toward the camera
    const cam = this.g.camera.position, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const dx = cam.x - cx, dz = cam.z - cz;
    const front = Math.abs(dz) >= Math.abs(dx) ? (dz > 0 ? 0 : 2) : dx > 0 ? 1 : 3;
    this.house.fp = { x0, x1, z0, z1, front };
    this.refreshHouseGhost();
    this.renderPanel();
    // glide the free camera over the new footprint so the whole house preview is in view
    const p = this.g.player;
    if (p.freeCam) {
      p.focusGoal = new THREE.Vector3(cx, this.g.terrain.heightAt(cx, cz) + 3, cz);
      p.camDist = Math.max(p.camDist, Math.hypot(x1 - x0, z1 - z0) * 1.6 + 12);
    }
  }

  houseRecs() {
    const f = this.house.fp;
    if (!f) return [];
    const baseY = Math.max(this.g.terrain.averageHeight(f.x0, f.z0, f.x1, f.z1), SEA + 0.3);
    return generateHouse({ ...f, baseY, floors: this.house.floors, style: this.house.style, roof: this.house.roof || null, furnish: this.house.furnish });
  }

  refreshHouseGhost() {
    this.clearGhost();
    const recs = this.houseRecs();
    if (!recs.length) return;
    const g = new THREE.Group();
    for (const r of recs) { const o = this.ghostObject(r); this.setTransform(o, r); g.add(o); }
    this.ghost = g;
    this.ghostKey = 'house';
    this.g.scene.add(g);
  }

  buildHouse() {
    const f = this.house.fp;
    if (!f) {
      // nothing outlined yet: put one on free ground in view, and let the player confirm it
      const p = this.g.player, at = p.freeCam ? p.focus : p.pos;
      this.proposeFootprint(at.x, at.z);
      this.g.ui.toast('Here is a free spot - press Build again, or click the ground to move it');
      return;
    }
    for (const [x, z] of [[f.x0 + 0.1, f.z0 + 0.1], [f.x1 - 0.1, f.z0 + 0.1], [f.x0 + 0.1, f.z1 - 0.1], [f.x1 - 0.1, f.z1 - 0.1]]) {
      if (!this.g.canBuild(x, z)) { this.deny(x, z); return; }
    }
    if (this.footprintBlocked(f)) { this.g.ui.toast('Something is already built there - click an empty spot on the ground', 'warn'); return; }
    // trees standing where the house goes are felled (natural ones get a cut record, planted ones removed)
    const felled = [];
    for (const t of this.g.trees.near((f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2, Math.hypot(f.x1 - f.x0, f.z1 - f.z0) / 2 + 3)) {
      if (t.x < f.x0 - 1.5 || t.x > f.x1 + 1.5 || t.z < f.z0 - 1.5 || t.z > f.z1 + 1.5) continue;
      if (this.isNatural(t.id)) felled.push({ id: this.g.newId(), t: 'cut', ref: t.id, x: t.x, y: t.y, z: t.z });
      else if (this.g.canModify(this.g.objects.get(t.id))) this.g.deleteObject(t.id);
    }
    if (felled.length) for (const c of felled) this.g.putObject(c);
    const recs = this.houseRecs();
    const baseY = recs[0].y;
    // level the ground under it so the foundation sits cleanly
    const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
    const r = Math.min(40, Math.hypot(f.x1 - f.x0, f.z1 - f.z0) / 2 + 3);
    this.g.terrainOp({ k: 'level', x: cx, z: cz, r, s: 1, y: baseY - 0.05 });
    const gid = 'h' + this.g.newId();
    this.commit(recs.map((rec) => ({ ...rec, id: this.g.newId(), g: gid })));
    this.house.fp = null;
    this.clearGhost();
    this.renderPanel();
    this.g.ui.toast(`Built a ${STYLES[this.house.style].label.toLowerCase()} with ${recs.length} parts. Select & edit (3) to change any piece.`);
    this.g.ui.sound('place');
  }

  // ---------------------------------------------------------------- terrain + nature brushes
  brushTick(p) {
    const b = this.brush;
    for (const [x, z] of [[p.x, p.z], [p.x - b.r, p.z - b.r], [p.x + b.r, p.z - b.r], [p.x - b.r, p.z + b.r], [p.x + b.r, p.z + b.r]]) {
      if (!this.g.canBuild(x, z)) { if (!this.strokeWarned) { this.deny(x, z); this.strokeWarned = true; } return; }
    }
    if (b.tool === 'flatten' && this.flattenY === null) this.flattenY = this.g.terrain.heightAt(p.x, p.z);
    const op = { k: b.tool, x: p.x, z: p.z, r: b.r, s: b.s };
    if (b.tool === 'flatten') op.y = this.flattenY;
    if (b.tool === 'paint') op.l = b.layer;
    this.g.terrainOp(op);
  }

  natureTick(p) {
    const n = this.nature, g = this.g;
    if (n.erase) {
      const ids = [];
      for (const t of g.trees.near(p.x, p.z, n.r)) {
        if (Math.hypot(t.x - p.x, t.z - p.z) > n.r || ids.length > 12) continue;
        if (this.isNatural(t.id)) { if (g.canBuild(t.x, t.z)) this.cutTree(t.id); }
        else ids.push(t.id);
      }
      for (const id of g.objects.near(p.x, p.z, n.r)) {
        const r = g.objects.get(id);
        if (r && ITEMS[r.t]?.cat === 'nature' && ITEMS[r.t].kind === 'model' && Math.hypot(r.x - p.x, r.z - p.z) < n.r) ids.push(id);
      }
      this.removeMany(ids);
      return;
    }
    const kinds = [...n.set];
    if (!kinds.length) return;
    const count = Math.max(1, Math.round(n.density * n.r * n.r / 40));
    const recs = [];
    for (let i = 0; i < count * 3 && recs.length < count; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * n.r;
      const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
      const y = g.terrain.heightAt(x, z);
      if (y < SEA + 0.4 || g.terrain.normalAt(x, z).y < 0.8 || !g.canBuild(x, z)) continue;
      const k = kinds[Math.floor(Math.random() * kinds.length)];
      const isTree = !!SPECIES[k];
      const minGap = isTree ? (k === 'bush' ? 1.6 : 3.2) : 1.2;
      if (g.trees.near(x, z, minGap).some((t) => Math.hypot(t.x - x, t.z - z) < minGap)) continue;
      if (recs.some((r) => Math.hypot(r.x - x, r.z - z) < minGap)) continue;
      const rec = { id: g.newId(), t: isTree ? 'tree:' + k : k, x, y: y - 0.05, z, ry: Math.random() * Math.PI * 2 };
      const sc = isTree ? 0.8 + Math.random() * 0.45 : 0.6 + Math.random() * 0.9;
      rec.s = [sc, sc, sc];
      if (isTree) rec.sd = Math.floor(Math.random() * 3);
      recs.push(rec);
    }
    if (recs.length) this.commit(recs);
  }

  drawRing(p, r) {
    const a = this.ring.geometry.attributes.position;
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * Math.PI * 2, x = p.x + Math.cos(t) * r, z = p.z + Math.sin(t) * r;
      a.setXYZ(i, x, this.g.terrain.heightAt(x, z) + 0.25, z);
    }
    a.needsUpdate = true;
    this.ring.visible = true;
  }

  // ---------------------------------------------------------------- plots overlay
  plotsChanged() {
    if (this.mode === 'land') { this.rebuildPlotOverlay(true); this.renderPanel(true); }
    this.g.ui.refreshMinimap = true;
  }

  rebuildPlotOverlay(force) {
    const p = this.g.player.pos;
    const key = plotKey(p.x, p.z);
    if (!force && key === this.overlayKey) return;
    this.overlayKey = key;
    const [pi, pj] = key.split(',').map(Number);
    const R = 7;
    const pos = [], col = [], fpos = [], fcol = [];
    const t = this.g.terrain, me = this.g.me.uid;
    const colorOf = (k) => {
      const pl = this.g.plots.get(k);
      if (!pl) return null;
      if (pl.owner === me) return [0.35, 0.95, 0.55];
      if (pl.open) return [0.4, 0.7, 1];
      return [1, 0.55, 0.35];
    };
    const H = (x, z) => t.heightAt(x, z) + 0.18;
    for (let j = pj - R; j <= pj + R; j++) {
      for (let i = pi - R; i <= pi + R; i++) {
        const x0 = i * PLOT, z0 = j * PLOT;
        if (Math.abs(x0) > HALF || Math.abs(z0) > HALF) continue;
        const k = i + ',' + j;
        const c = colorOf(k);
        const sel = k === this.landSel;
        const lc = sel ? [1, 1, 1] : c || [0.85, 0.88, 0.9];
        const edge = (ax, az, bx, bz) => {
          const n = PLOT / 2;
          for (let s = 0; s < n; s++) {
            const u0 = s / n, u1 = (s + 1) / n;
            const xa = ax + (bx - ax) * u0, za = az + (bz - az) * u0, xb = ax + (bx - ax) * u1, zb = az + (bz - az) * u1;
            pos.push(xa, H(xa, za), za, xb, H(xb, zb), zb);
            col.push(...lc, ...lc);
          }
        };
        edge(x0, z0, x0 + PLOT, z0); edge(x0, z0, x0, z0 + PLOT);
        if (sel) { edge(x0 + PLOT, z0, x0 + PLOT, z0 + PLOT); edge(x0, z0 + PLOT, x0 + PLOT, z0 + PLOT); }
        if (c || sel) {
          const fc = sel && !c ? [1, 1, 1] : c;
          const n = 8, st = PLOT / n;
          for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
            const xa = x0 + a * st, za = z0 + b * st, xb = xa + st, zb = za + st;
            fpos.push(xa, H(xa, za), za, xb, H(xb, za), za, xb, H(xb, zb), zb, xa, H(xa, za), za, xb, H(xb, zb), zb, xa, H(xa, zb), zb);
            for (let q = 0; q < 6; q++) fcol.push(...fc);
          }
        }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.plotLines.geometry.dispose(); this.plotLines.geometry = lg;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
    fg.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
    this.plotFill.geometry.dispose(); this.plotFill.geometry = fg;
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    this.pumpThumbs();
    const ray = this.mouse && !this.g.player.dragging ? this.g.rayFromEvent(this.mouse) : null;
    const m = this.mode;
    if (m === 'build') {
      if (!this.item || !ray) { if (this.ghost) this.ghost.visible = false; this.outline.visible = false; return; }
      const it = ITEMS[this.item];
      const key = [this.item, this.mat, this.tint].join('|');
      if (key !== this.ghostKey) {
        this.clearGhost();
        this.ghost = this.ghostObject({ t: this.item, m: this.mat || it.mat, c: this.tint, sd: 0 });
        this.ghostKey = key;
        this.g.scene.add(this.ghost);
      }
      // dragging out a run of walls: one preview per piece
      if (this.line) {
        const recs = this.lineRecs(this.line.start, ray);
        this.line.recs = recs;
        if (recs.length > 1) {
          if (!this.lineGhost) { this.lineGhost = new THREE.Group(); this.g.scene.add(this.lineGhost); }
          while (this.lineGhost.children.length < recs.length) this.lineGhost.add(this.ghostObject({ t: this.item, m: this.mat || it.mat, c: this.tint }));
          this.lineGhost.children.forEach((o, i) => { o.visible = i < recs.length; if (recs[i]) this.setTransform(o, recs[i]); });
          this.ghost.visible = false;
          this.outline.visible = false;
          this.g.ui.hint(`${recs.length} × ${it.label.toLowerCase()} - release to build them all`);
          return;
        }
      }
      if (this.lineGhost) { this.g.scene.remove(this.lineGhost); this.lineGhost = null; }
      const pl = this.placementFor(ray, it, this.ry, this.scale);
      if (!pl) { this.ghost.visible = false; return; }
      const r = { t: this.item, x: pl.x, y: pl.y, z: pl.z, ry: pl.ry ?? this.ry, s: this.scale };
      this.ghost.visible = true;
      this.setTransform(this.ghost, r);
      this.showOutline(r, this.g.canBuild(pl.x, pl.z));
      this.g.ui.hint(`${it.label} · ${pl.x.toFixed(1)}, ${pl.z.toFixed(1)} · height ${pl.y.toFixed(2)} m${this.lift ? ` (lift ${this.lift > 0 ? '+' : ''}${this.lift})` : ''}`);
    } else if (m === 'edit') {
      if (this.carry) {
        const c = this.carry;
        if (!this.ghost) {
          const g = new THREE.Group();
          for (const r of c.recs) { const o = this.ghostObject(r); o.userData.rec = r; g.add(o); }
          this.ghost = g; this.ghostKey = 'carry';
          this.g.scene.add(g);
          for (const id of c.ids) this.g.objects.removeRec(id);
          // keep the originals for cancel
          c.hidden = true;
        }
        if (ray) {
          const pl = this.placementFor(ray, ITEMS[c.anchor.t], c.anchor.ry, c.anchor.s || [1, 1, 1]);
          if (pl) {
            const out = this.carryTransform(c, pl);
            this.ghost.children.forEach((o, i) => this.setTransform(o, out[i]));
            this.showOutline(out[0], out.every((r) => this.g.canBuild(r.x, r.z)));
          }
        }
      } else if (this.multi.size > 1) {
        // one outline per selected piece
        const ids = [...this.multi];
        while (this.extraOutlines.length < ids.length) { const o = this.outline.clone(); o.material = this.outline.material; this.g.scene.add(o); this.extraOutlines.push(o); }
        this.extraOutlines.forEach((o, i) => {
          const r = ids[i] && this.g.objects.get(ids[i]);
          o.visible = !!r;
          if (r) { this.showOutline(r, true); o.position.copy(this.outline.position); o.rotation.copy(this.outline.rotation); o.scale.copy(this.outline.scale); }
        });
        this.outline.visible = false;
      } else if (this.sel) {
        for (const o of this.extraOutlines) o.visible = false;
        const r = this.g.objects.get(this.sel);
        const t = !r && this.g.trees.items.get(this.sel);
        if (r) this.showOutline(r, this.g.canModify(r));
        else if (t) this.showOutline({ t: 'tree:oak', x: t.x, y: t.y, z: t.z, ry: 0, s: [t.s, t.s, t.s] }, this.g.canBuild(t.x, t.z));
        else this.outline.visible = false;
      }
    } else if (m === 'terrain' || m === 'nature') {
      const p = ray && this.g.terrain.raycast(ray);
      if (!p) { this.ring.visible = false; return; }
      const r = m === 'terrain' ? this.brush.r : this.nature.r;
      this.drawRing(p, r);
      this.ring.material.color.set(this.g.canBuild(p.x, p.z) ? (m === 'nature' && this.nature.erase ? 0xff8a7a : 0xffffff) : 0xff6a5a);
      if (this.painting) {
        this.paintClock += dt;
        const every = m === 'terrain' ? 0.07 : 0.3;
        if (this.paintClock >= every) { this.paintClock = 0; m === 'terrain' ? this.brushTick(p) : this.natureTick(p); }
      }
    } else if (m === 'house') {
      if (this.house.drag && ray) {
        const p = this.g.terrain.raycast(ray);
        if (p) this.house.drag.b.copy(p);
        const d = this.house.drag;
        const x0 = Math.floor(Math.min(d.a.x, d.b.x) / 4) * 4, x1 = Math.ceil(Math.max(d.a.x, d.b.x) / 4) * 4;
        const z0 = Math.floor(Math.min(d.a.z, d.b.z) / 4) * 4, z1 = Math.ceil(Math.max(d.a.z, d.b.z) / 4) * 4;
        const w = Math.min(24, Math.max(8, x1 - x0)), dd = Math.min(24, Math.max(8, z1 - z0));
        this.showOutline({ t: 'floor', x: x0 + w / 2, y: this.g.terrain.heightAt(x0 + w / 2, z0 + dd / 2), z: z0 + dd / 2, ry: 0, s: [w / 4, 20, dd / 4] }, true);
        this.g.ui.hint(`Footprint ${w} × ${dd} m`);
      } else if (this.house.fp) {
        const f = this.house.fp;
        this.showOutline({ t: 'floor', x: (f.x0 + f.x1) / 2, y: this.g.terrain.heightAt((f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2), z: (f.z0 + f.z1) / 2, ry: 0, s: [(f.x1 - f.x0) / 4, 2, (f.z1 - f.z0) / 4] },
          [[f.x0, f.z0], [f.x1 - 0.1, f.z1 - 0.1]].every(([x, z]) => this.g.canBuild(x, z)));
      }
    } else if (m === 'land') {
      this.rebuildPlotOverlay(false);
      const p = ray && this.g.terrain.raycast(ray);
      if (p) {
        const k = plotKey(p.x, p.z), pl = this.g.plots.get(k);
        this.g.ui.hint(pl ? `Plot ${k} · ${pl.name || 'unnamed'} · owner: ${this.g.ownerName(pl.owner)}${pl.open ? ' · open to all builders' : ''}` : `Plot ${k} · free - click to select, then claim it`);
      }
    }
  }

  // ---------------------------------------------------------------- thumbnails for parts and trees
  thumb(id) {
    if (this.thumbs.has(id)) return this.thumbs.get(id);
    const it = ITEMS[id];
    if (it.thumb) return it.thumb;
    if (!this.thumbQueue.includes(id)) this.thumbQueue.push(id);
    return '';
  }

  pumpThumbs() {
    if (!this.thumbQueue.length) return;
    if (!this.thumbRig) {
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.6));
      const d = new THREE.DirectionalLight(0xffffff, 2.2); d.position.set(3, 5, 4); scene.add(d);
      const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
      const rt = new THREE.WebGLRenderTarget(128, 128, { samples: 4 });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      this.thumbRig = { scene, cam, rt, buf: new Uint8Array(128 * 128 * 4), canvas: Object.assign(document.createElement('canvas'), { width: 128, height: 128 }) };
    }
    const { scene, cam, rt, buf, canvas } = this.thumbRig;
    const id = this.thumbQueue.shift();
    const it = ITEMS[id];
    const obj = this.ghostObject({ t: id, m: it.mat, sd: 0 });
    scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj);
    if (it.kind === 'tree') box.set(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, obj.children[0]?.userData.height || 10, 4));
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    cam.position.copy(c).add(new THREE.Vector3(0.9, 0.7, 1.3).normalize().multiplyScalar(r / Math.tan(THREE.MathUtils.degToRad(15)) * 1.02));
    cam.lookAt(c);
    const r0 = this.g.renderer;
    const prev = r0.getRenderTarget(), prevTM = r0.toneMapping;
    scene.environment = this.g.scene.environment;
    r0.setRenderTarget(rt);
    r0.setClearColor(0x000000, 0); r0.clear();
    r0.render(scene, cam);
    r0.readRenderTargetPixels(rt, 0, 0, 128, 128, buf);
    r0.setRenderTarget(prev);
    r0.toneMapping = prevTM;
    scene.remove(obj);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(128, 128);
    for (let y = 0; y < 128; y++) img.data.set(buf.subarray((127 - y) * 512, (128 - y) * 512), y * 512);
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL();
    this.thumbs.set(id, url);
    document.querySelectorAll(`[data-thumb="${CSS.escape(id)}"]`).forEach((el) => { el.style.backgroundImage = `url(${url})`; });
  }

  // ---------------------------------------------------------------- panels
  renderPanel(soft) {
    const el = this.panel();
    if (!el) return;
    if (soft && this.mode === 'build' && el.querySelector('.cat-grid')) { this.updateBuildReadout(el); return; }
    const h = { explore: () => this.panelExplore(), build: () => this.panelBuild(), edit: () => this.panelEdit(), house: () => this.panelHouse(), terrain: () => this.panelTerrain(), nature: () => this.panelNature(), land: () => this.panelLand() }[this.mode];
    el.innerHTML = h();
    el.onclick = (e) => this.onPanelClick(e);
    el.oninput = (e) => this.onPanelInput(e);
    if (this.mode === 'build') this.updateBuildReadout(el);
  }

  panelExplore() {
    return `<h3>Explore</h3>
      <p class="muted">Walk with <b>W A S D</b>, run with <b>Shift</b>, jump with <b>Space</b>. Drag with the mouse to look around, scroll to zoom (all the way in for first person). <b>F</b> toggles flying. <b>V</b> switches to the free camera for looking around buildings.</p>
      <p class="muted">Click another resident to see their card, message them or visit them.</p>
      <div class="btn-row"><button data-act="mode" data-v="build">Start building</button><button data-act="mode" data-v="house" class="ghost">Generate a house</button></div>
      <h4>Emotes</h4>
      <div class="chip-row">${['wave', 'cheer', 'clap', 'point', 'dance', 'sit'].map((e) => `<button class="chip" data-act="emote" data-v="${e}">${e}</button>`).join('')}</div>`;
  }

  panelBuild() {
    const cats = [{ id: 'fav', label: '★ Favourites' }, ...CATEGORIES, { id: 'bp', label: 'Blueprints' }]
      .map((c) => `<button class="tab ${c.id === this.cat && !this.query ? 'on' : ''}" data-act="cat" data-v="${c.id}">${c.label}</button>`).join('');
    return `<h3>Build</h3>
      <input class="search" data-in="search" placeholder="Search everything… (sofa, lamp, roof)" value="${esc(this.query)}" autocomplete="off">
      <div class="tabs">${cats}</div><div class="cat-grid">${this.gridHtml()}</div><div class="readout"></div>`;
  }

  gridHtml() {
    if (this.cat === 'bp' && !this.query) return this.blueprintsHtml();
    const q = this.query.trim().toLowerCase();
    const list = Object.values(ITEMS).filter((it) => it.cat !== 'hidden' && (q ? it.label.toLowerCase().includes(q) || it.cat.includes(q) : this.cat === 'fav' ? this.favs.has(it.id) : it.cat === this.cat));
    if (!list.length) return `<p class="muted span">${q ? 'Nothing matches that.' : this.cat === 'fav' ? 'Star items (☆ on their card) to collect them here.' : ''}</p>`;
    return list.map((it) => {
      const th = this.thumb(it.id);
      return `<button class="card ${it.id === this.item ? 'on' : ''}" data-act="item" data-v="${it.id}" title="${esc(it.label)}"><span class="th" data-thumb="${it.id}" style="${th ? `background-image:url(${th})` : ''}"></span><span class="lb">${esc(it.label)}</span><span class="star ${this.favs.has(it.id) ? 'on' : ''}" data-act="fav" data-v="${it.id}" title="Favourite">${this.favs.has(it.id) ? '★' : '☆'}</span></button>`;
    }).join('');
  }

  blueprintsHtml() {
    const list = this.blueprints();
    return `<div class="span">
      <p class="muted">Save any build as a blueprint (select it with Select & edit, then <b>Save as blueprint</b>), place copies of it anywhere, or share it with a code.</p>
      ${list.length ? `<div class="list">${list.map((b, i) => `<div class="bp-row"><span><b>${esc(b.name)}</b><small class="muted">${b.items.length} pieces</small></span>
        <button class="chip" data-act="bpplace" data-v="${i}">Place</button><button class="chip" data-act="bpshare" data-v="${i}">Share</button><button class="chip" data-act="bpdel" data-v="${i}">×</button></div>`).join('')}</div>` : '<p class="muted">No blueprints yet.</p>'}
      <h4>Import a code</h4><div class="row"><input class="search" data-in="bpcode" placeholder="RELIVE1:…"><button class="chip" data-act="bpimport">Import</button></div></div>`;
  }

  updateBuildReadout(el) {
    const ro = el.querySelector('.readout');
    if (!ro) return;
    const it = this.item && ITEMS[this.item];
    if (!it) { ro.innerHTML = '<p class="muted">Pick an item above, then click in the world to place it. <b>R</b> turns 90°, <b>Q/E</b> turn 15°, <b>[ ]</b> lift, <b>G</b> toggles the grid.</p>'; return; }
    const mats = it.kind === 'part' ? it.mats : null;
    const cur = this.mat || it.mat;
    ro.innerHTML = `
      <div class="sel-title">${esc(it.label)}</div>
      ${mats ? `<h4>Finish</h4><div class="swatches">${mats.map((k) => `<button class="sw ${k === cur ? 'on' : ''}" data-act="mat" data-v="${k}" title="${esc(MATERIALS[k].label)}" style="background:${MATERIALS[k].col} ${swatchUrl(k) ? `url(${swatchUrl(k)}) center/cover` : ''}"></button>`).join('')}</div>` : ''}
      ${it.kind !== 'tree' ? `<h4>Colour tint</h4><div class="row"><input type="color" data-in="tint" value="${this.tint || '#ffffff'}"><button class="chip ${this.tint ? '' : 'on'}" data-act="notint">none</button></div>` : ''}
      <h4>Size</h4>${it.kind === 'part'
        ? ['Width', 'Height', 'Depth'].map((l, i) => `<label class="slider">${l}<input type="range" min="0.25" max="4" step="0.25" value="${this.scale[i]}" data-in="scale${i}"><span>${this.scale[i]}×</span></label>`).join('')
        : `<label class="slider">Scale<input type="range" min="0.3" max="3" step="0.05" value="${this.scale[0]}" data-in="uscale"><span>${this.scale[0]}×</span></label>`}
      <div class="row small"><span>Turn ${Math.round(this.ry * 180 / Math.PI)}°</span><span>Lift ${this.lift} m</span><span>Grid ${this.snapOn ? 'on' : 'off'}</span></div>
      <div class="btn-row"><button class="ghost" data-act="rot">Turn 90°</button><button class="ghost" data-act="snap">${this.snapOn ? 'Free place' : 'Snap to grid'}</button><button class="ghost" data-act="reset">Reset</button></div>`;
  }

  panelEdit() {
    if (this.carry) return `<h3>${this.carry.isNew ? 'Placing a blueprint' : 'Moving'}</h3><p class="muted">Click to drop it. <b>R</b> / <b>Q</b> / <b>E</b> turn it, <b>[ ]</b> lift, <b>Esc</b> cancels.</p><button class="ghost" data-act="cancelcarry">Cancel</button>`;
    if (this.multi.size > 1) {
      return `<h3>${this.multi.size} pieces selected</h3>
        <p class="muted">Shift+click adds or removes pieces. Move, delete or save them together.</p>
        <div class="btn-row"><button data-act="move">Move them</button><button class="danger" data-act="delete">Delete them</button></div>
        <div class="btn-row"><button class="ghost" data-act="bpsave">Save as blueprint</button><button class="ghost" data-act="clearsel">Clear selection</button></div>`;
    }
    const id = this.sel;
    if (!id) return `<h3>Select & edit</h3><p class="muted">Click any object, tree or part of a building to select it. <b>Shift+click</b> selects several. Then move it (<b>G</b>), turn it (<b>R</b>), delete it (<b>Del</b>), copy it (<b>Ctrl+D</b>) or change its finish. <b>Ctrl+Z</b> undoes.</p>`;
    if (this.isNatural(id)) {
      const t = this.g.trees.items.get(id);
      const sp = t && this.g.trees.variants[t.vi].sp;
      return `<h3>${esc(sp ? sp.label : 'Tree')}</h3><p class="muted">Part of the island's natural forest.</p><div class="btn-row"><button class="danger" data-act="delete">Cut down</button></div>`;
    }
    const r = this.g.objects.get(id);
    if (!r) return '<h3>Select & edit</h3><p class="muted">That object is gone.</p>';
    const it = ITEMS[r.t];
    const can = this.g.canModify(r);
    const grp = r.g ? this.g.objects.groupIds(r.g).length : 0;
    const s = r.s || [1, 1, 1];
    return `<h3>${esc(it.label)}</h3>
      <p class="muted">Built by <b>${esc(this.g.ownerName(r.owner))}</b>${grp > 1 ? ` · part of a ${grp}-piece build` : ''}</p>
      ${can ? `
        ${it.kind === 'part' ? `<h4>Finish</h4><div class="swatches">${it.mats.map((k) => `<button class="sw ${k === (r.m || it.mat) ? 'on' : ''}" data-act="smat" data-v="${k}" title="${esc(MATERIALS[k].label)}" style="background:${MATERIALS[k].col} ${swatchUrl(k) ? `url(${swatchUrl(k)}) center/cover` : ''}"></button>`).join('')}</div>` : ''}
        ${it.kind !== 'tree' ? `<h4>Colour tint</h4><div class="row"><input type="color" data-in="stint" value="${r.c || '#ffffff'}"><button class="chip ${r.c ? '' : 'on'}" data-act="snotint">none</button></div>` : ''}
        <h4>Size</h4>${it.kind === 'part'
          ? ['Width', 'Height', 'Depth'].map((l, i) => `<label class="slider">${l}<input type="range" min="0.25" max="4" step="0.25" value="${s[i]}" data-in="sscale${i}"><span>${s[i]}×</span></label>`).join('')
          : `<label class="slider">Scale<input type="range" min="0.3" max="3" step="0.05" value="${s[0]}" data-in="suscale"><span>${s[0]}×</span></label>`}
        <div class="btn-row"><button data-act="move">Move</button><button class="ghost" data-act="srot">Turn 90°</button><button class="ghost" data-act="dup">Copy</button><button class="danger" data-act="delete">Delete</button></div>
        ${grp > 1 ? `<div class="btn-row"><button class="ghost" data-act="movegroup">Move whole build</button><button class="danger ghost" data-act="delgroup">Delete whole build</button></div>` : ''}
        <div class="btn-row"><button class="ghost" data-act="bpsave">${grp > 1 ? 'Save whole build as blueprint' : 'Save as blueprint'}</button></div>`
      : `<p class="warn-box">You can look, but only the builder${this.g.plotAt(r.x, r.z) ? ' or the plot owner' : ''} can change it.</p>`}`;
  }

  panelHouse() {
    const st = Object.entries(STYLES).map(([k, s]) => `<button class="card wide ${k === this.house.style ? 'on' : ''}" data-act="hstyle" data-v="${k}"><span class="lb">${esc(s.label)}</span></button>`).join('');
    const f = this.house.fp;
    return `<h3>House generator</h3>
      <p class="muted">${f ? `The outline shows where it goes: ${f.x1 - f.x0} × ${f.z1 - f.z0} m, door facing the camera. Click the ground to move it, or drag a rectangle (8-24 m a side) to resize.` : 'Click the ground where the house should go, or drag a rectangle (8-24 m a side).'}</p>
      <p class="muted">Camera: <b>W A S D</b> moves over the land, right-drag turns, scroll zooms, <b>Q</b>/<b>E</b> orbit.</p>
      <h4>Style</h4><div class="cards2">${st}</div>
      <h4>Storeys</h4><div class="chip-row">${[1, 2, 3].map((n) => `<button class="chip ${n === this.house.floors ? 'on' : ''}" data-act="hfloors" data-v="${n}">${n}</button>`).join('')}</div>
      <h4>Roof</h4><div class="chip-row">${[['', 'Style default'], ['gable', 'Gable'], ['hip', 'Hip'], ['flat', 'Flat']].map(([k, l]) => `<button class="chip ${k === this.house.roof ? 'on' : ''}" data-act="hroof" data-v="${k}">${l}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" data-in="hfurnish" ${this.house.furnish ? 'checked' : ''}> Furnish it (sofa, table, bed, lights, path)</label>
      <div class="btn-row"><button data-act="hbuild">${f ? 'Build this house' : 'Place a house'}</button>${f ? '<button class="ghost" data-act="hmove">Find a free spot</button>' : ''}</div>`;
  }

  panelTerrain() {
    const b = this.brush;
    const tools = [['raise', 'Raise'], ['lower', 'Lower'], ['flatten', 'Flatten'], ['smooth', 'Smooth'], ['paint', 'Paint']];
    return `<h3>Landscape</h3>
      <p class="muted">Hold the left mouse button and sweep over the ground. You can reshape public land and your own plots.</p>
      <div class="chip-row">${tools.map(([k, l]) => `<button class="chip ${k === b.tool ? 'on' : ''}" data-act="ttool" data-v="${k}">${l}</button>`).join('')}</div>
      ${b.tool === 'paint' ? `<h4>Ground</h4><div class="swatches">${LAYERS.map((l, i) => `<button class="sw big ${i === b.layer ? 'on' : ''}" data-act="tlayer" data-v="${i}" title="${l.label}" style="background:url(https://cdn.polyhaven.com/asset_img/thumbs/${l.ph}.png?width=64&height=64) center/cover"></button>`).join('')}</div>` : ''}
      <label class="slider">Brush size<input type="range" min="2" max="30" step="1" value="${b.r}" data-in="tr"><span>${b.r} m</span></label>
      <label class="slider">Strength<input type="range" min="0.05" max="1" step="0.05" value="${b.s}" data-in="ts"><span>${b.s}</span></label>`;
  }

  panelNature() {
    const n = this.nature;
    const opts = [...Object.entries(SPECIES).map(([k, s]) => [k, s.label]), ['m:shrub_02', 'Shrub'], ['m:fern_02', 'Fern'], ['m:rock_09', 'Rocks'], ['m:boulder_01', 'Boulders'], ['m:stone_01', 'Stones']];
    return `<h3>Nature</h3>
      <p class="muted">Hold the left mouse button to plant. Pick one or more kinds; they mix naturally.</p>
      <div class="chip-row">${opts.map(([k, l]) => `<button class="chip ${n.set.has(k) ? 'on' : ''}" data-act="nkind" data-v="${k}">${l}</button>`).join('')}</div>
      <label class="slider">Brush size<input type="range" min="3" max="30" step="1" value="${n.r}" data-in="nr"><span>${n.r} m</span></label>
      <label class="slider">Density<input type="range" min="0.1" max="1" step="0.05" value="${n.density}" data-in="nd"><span>${n.density}</span></label>
      <label class="check"><input type="checkbox" data-in="nerase" ${n.erase ? 'checked' : ''}> Eraser (clears trees and plants under the brush)</label>`;
  }

  panelLand() {
    const mine = [...this.g.plots.entries()].filter(([, p]) => p.owner === this.g.me.uid);
    const k = this.landSel;
    let sel = '<p class="muted">Click a square on the ground to select a plot. Plots are 32 × 32 m. While you own one, only you (and anyone you let in) can build or reshape there.</p>';
    if (k) {
      const o = plotOrigin(k), p = this.g.plots.get(k);
      const inIsland = Math.abs(o.x) < HALF && Math.abs(o.z) < HALF;
      if (!p) sel = `<div class="sel-title">Plot ${k}</div><p class="muted">Free land${inIsland ? '' : ' (out at sea)'}.</p>
        <label class="field">Name<input data-in="pname" maxlength="40" placeholder="My home" value=""></label>
        <button data-act="claim" ${inIsland ? '' : 'disabled'}>Claim this plot</button>`;
      else if (p.owner === this.g.me.uid) sel = `<div class="sel-title">${esc(p.name || 'Plot ' + k)}</div><p class="muted">Yours.</p>
        <label class="field">Name<input data-in="pname" maxlength="40" value="${esc(p.name)}"></label>
        <label class="check"><input type="checkbox" data-in="popen" ${p.open ? 'checked' : ''}> Let anyone build here</label>
        <div class="btn-row"><button data-act="psave">Save</button><button class="danger ghost" data-act="release">Give up plot</button></div>`;
      else sel = `<div class="sel-title">${esc(p.name || 'Plot ' + k)}</div><p class="muted">Owned by <b>${esc(this.g.ownerName(p.owner))}</b>${p.open ? ' · open for everyone to build' : ''}.</p>`;
    }
    return `<h3>Land & plots</h3>${sel}
      <h4>Your plots (${mine.length}/6)</h4>
      ${mine.length ? `<div class="list">${mine.map(([key, p]) => `<button class="list-row" data-act="gotoplot" data-v="${key}"><span>${esc(p.name || 'Plot ' + key)}</span><span class="muted">${key}</span></button>`).join('')}</div>` : '<p class="muted">None yet.</p>'}
      <div class="legend"><span><i style="background:#59f28c"></i>yours</span><span><i style="background:#ff8c59"></i>taken</span><span><i style="background:#66b3ff"></i>open</span></div>`;
  }

  onPanelClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const v = b.dataset.v, g = this.g;
    switch (b.dataset.act) {
      case 'mode': this.setMode(v); break;
      case 'emote': g.emote(v); break;
      case 'cat': this.cat = v; this.query = ''; this.renderPanel(); break;
      case 'fav': {
        e.stopPropagation();
        this.favs.has(v) ? this.favs.delete(v) : this.favs.add(v);
        g.store.set('favs', [...this.favs]);
        const grid = this.panel().querySelector('.cat-grid'); if (grid) grid.innerHTML = this.gridHtml();
        return;
      }
      case 'bpplace': this.placeBlueprint(+v); break;
      case 'bpshare': {
        const code = this.bpCode(this.blueprints()[+v]);
        navigator.clipboard?.writeText(code).then(() => g.ui.toast('Blueprint code copied - paste it to a friend'), () => prompt('Copy this blueprint code:', code));
        break;
      }
      case 'bpdel': { const list = this.blueprints(); list.splice(+v, 1); g.store.set('blueprints', list); this.renderPanel(); break; }
      case 'bpimport': this.importBlueprint(this.panel().querySelector('[data-in=bpcode]').value); break;
      case 'bpsave': {
        const r = g.objects.get(this.sel);
        const ids = this.multi.size ? [...this.multi] : r && r.g ? g.objects.groupIds(r.g) : this.selectedIds();
        const name = prompt('Name this blueprint:', r ? (r.g && ids.length > 20 ? 'My house' : ITEMS[r.t].label) : 'My build');
        if (name !== null) this.saveBlueprint(ids, name.trim().slice(0, 40));
        break;
      }
      case 'clearsel': this.select(null); break;
      case 'item': this.item = v; this.mat = null; this.scale = [1, 1, 1]; this.lift = 0; this.ry = ITEMS[v].kind === 'part' ? Math.round(this.ry / (Math.PI / 2)) * Math.PI / 2 : this.ry; this.renderPanel(); break;
      case 'mat': this.mat = v; this.renderPanel(true); break;
      case 'notint': this.tint = null; this.renderPanel(true); break;
      case 'rot': this.rotate('tool', Math.PI / 2); break;
      case 'snap': this.snapOn = !this.snapOn; this.renderPanel(true); break;
      case 'reset': this.scale = [1, 1, 1]; this.lift = 0; this.ry = 0; this.tint = null; this.renderPanel(true); break;
      case 'smat': case 'snotint': {
        const r = g.objects.get(this.sel); if (!r) break;
        this.commit([b.dataset.act === 'smat' ? { ...r, m: v } : { ...r, c: undefined }]);
        this.renderPanel();
        break;
      }
      case 'srot': this.rotate('sel', Math.PI / 2); break;
      case 'move': this.startCarry(false); this.renderPanel(); break;
      case 'movegroup': this.startCarry(true); this.renderPanel(); break;
      case 'cancelcarry': this.cancelCarry(); break;
      case 'dup': this.duplicate(); break;
      case 'delete': this.deleteSelection(); break;
      case 'delgroup': {
        const r = g.objects.get(this.sel);
        if (r && r.g && confirm('Delete the whole build?')) { const n = this.removeMany(g.objects.groupIds(r.g)); this.select(null); g.ui.toast(`Removed ${n} pieces (Ctrl+Z brings them back)`); }
        break;
      }
      case 'hstyle': this.house.style = v; this.refreshHouseGhost(); this.renderPanel(); break;
      case 'hfloors': this.house.floors = +v; this.refreshHouseGhost(); this.renderPanel(); break;
      case 'hroof': this.house.roof = v; this.refreshHouseGhost(); this.renderPanel(); break;
      case 'hbuild': this.buildHouse(); break;
      case 'hmove': { const f = this.house.fp; this.house.fp = null; this.proposeFootprint((f.x0 + f.x1) / 2 + 16, (f.z0 + f.z1) / 2); break; }
      case 'hclear': this.house.fp = null; this.clearGhost(); this.renderPanel(); break;
      case 'ttool': this.brush.tool = v; this.renderPanel(); break;
      case 'tlayer': this.brush.layer = +v; this.renderPanel(); break;
      case 'nkind': this.nature.set.has(v) ? this.nature.set.delete(v) : this.nature.set.add(v); this.renderPanel(); break;
      case 'claim': {
        const name = this.panel().querySelector('[data-in=pname]').value.trim();
        g.claimPlot(this.landSel, name, false);
        break;
      }
      case 'psave': {
        const p = this.panel();
        g.claimPlot(this.landSel, p.querySelector('[data-in=pname]').value.trim(), p.querySelector('[data-in=popen]').checked);
        g.ui.toast('Plot saved');
        break;
      }
      case 'release': if (confirm('Give up this plot? What you built stays, but anyone could build here again.')) g.releasePlot(this.landSel); break;
      case 'gotoplot': { const o = plotOrigin(v); g.teleport(o.x + PLOT / 2, o.z + PLOT / 2); this.landSel = v; this.rebuildPlotOverlay(true); this.renderPanel(); break; }
    }
  }

  onPanelInput(e) {
    const t = e.target, k = t.dataset.in, g = this.g;
    if (!k) return;
    const span = t.parentElement.querySelector('span');
    if (k === 'search') { this.query = t.value; const grid = this.panel().querySelector('.cat-grid'); if (grid) grid.innerHTML = this.gridHtml(); return; }
    if (k === 'bpcode') return;
    if (k === 'tint') { this.tint = t.value; this.ghostKey = ''; return; }
    if (k.startsWith('scale')) { this.scale[+k.slice(5)] = +t.value; if (span) span.textContent = t.value + '×'; return; }
    if (k === 'uscale') { this.scale = [+t.value, +t.value, +t.value]; if (span) span.textContent = t.value + '×'; return; }
    if (k === 'tr') { this.brush.r = +t.value; span.textContent = t.value + ' m'; return; }
    if (k === 'ts') { this.brush.s = +t.value; span.textContent = t.value; return; }
    if (k === 'nr') { this.nature.r = +t.value; span.textContent = t.value + ' m'; return; }
    if (k === 'nd') { this.nature.density = +t.value; span.textContent = t.value; return; }
    if (k === 'nerase') { this.nature.erase = t.checked; return; }
    if (k === 'hfurnish') { this.house.furnish = t.checked; this.refreshHouseGhost(); return; }
    // live edits to the selection; sliders commit when released (change), colour on every input
    const r = g.objects.get(this.sel);
    if (!r) return;
    if (k === 'stint') { clearTimeout(this.tintTimer); this.tintTimer = setTimeout(() => this.commit([{ ...g.objects.get(this.sel), c: t.value }]), 150); return; }
    if (e.type === 'input' && span) span.textContent = t.value + '×';
    clearTimeout(this.scaleTimer);
    this.scaleTimer = setTimeout(() => {
      const cur = g.objects.get(this.sel); if (!cur) return;
      const s = [...(cur.s || [1, 1, 1])];
      if (k === 'suscale') s[0] = s[1] = s[2] = +t.value; else s[+k.slice(6)] = +t.value;
      this.commit([{ ...cur, s }]);
    }, 200);
  }
}

function norm(a) { a %= Math.PI * 2; return a < 0 ? a + Math.PI * 2 : a; }
