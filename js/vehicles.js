// Things to drive: the sports car (three.js's Ferrari), a bicycle and a motor boat (both built here).
// Arcade physics: a bicycle-model turning circle, wheels that follow the ground and the roads you built,
// bumps off walls and trees, boats that only go where the water is deep enough. Every vehicle uses the
// same heading convention as avatars: heading h faces (-sin h, -cos h).
// While someone drives, their position updates carry the vehicle's pose; when they get out, the new
// parking spot is saved if they're allowed to edit that vehicle, otherwise it's just shown to everyone.
import * as THREE from 'three';
import { ITEMS } from './catalog.js';
import { loadCar } from './assets.js';
import { SEA, HALF } from './config.js';

export const VTYPES = {
  car:  { label: 'sports car', verb: 'Drive', maxF: 30, maxR: 8, accel: 8, brake: 20, drag: 0.35, steerMax: 0.55, wb: 2.66, track: 1.66, r: 0.36, radius: 1.0, step: 0.45, cam: 8.5, camH: 1.5, seat: [-0.36, 0.08, 0.15], exit: [-1.7, 0], medium: 'land' },
  bike: { label: 'bicycle',    verb: 'Ride',  maxF: 9,  maxR: 1.5, accel: 3.2, brake: 8, drag: 0.5, steerMax: 0.6, wb: 1.04, track: 0, r: 0.34, radius: 0.45, step: 0.3, cam: 4.6, camH: 1.7, seat: [0, 0.55, 0.12], exit: [-0.9, 0], medium: 'land' },
  boat: { label: 'motor boat', verb: 'Take',  maxF: 15, maxR: 3.5, accel: 4.2, brake: 6, drag: 0.25, steerMax: 0.6, wb: 2.4, track: 1.5, r: 0, radius: 1.3, step: 0, cam: 10, camH: 2.2, seat: [0, 0.05, 1.3], exit: [-2.4, 0], medium: 'water' },
};

const UP = new THREE.Vector3(0, 1, 0);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------ procedural models (facing -z)
function tube(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  m.castShadow = true;
  return m;
}

function makeBike(color) {
  const g = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1c1c1e', roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ color: '#c9ccd1', metalness: 1, roughness: 0.3 });
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const wheels = [];
  for (const z of [0.52, -0.52]) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.028, 8, 32), dark); tire.rotation.y = Math.PI / 2; w.add(tire);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.01, 6, 32), steel); rim.rotation.y = Math.PI / 2; w.add(rim);
    for (let i = 0; i < 8; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.6, 0.006), steel); s.rotation.x = (i / 8) * Math.PI; w.add(s); }
    w.position.set(0, 0.34, z);
    g.add(w); wheels.push(w);
  }
  const rear = V(0, 0.34, 0.52), bb = V(0, 0.3, 0.06), seatTop = V(0, 0.84, 0.2), head = V(0, 0.88, -0.36), headLow = V(0, 0.7, -0.4), front = V(0, 0.34, -0.52);
  for (const [a, b, r] of [[rear, bb, 0.016], [rear, seatTop, 0.014], [bb, seatTop, 0.02], [bb, headLow, 0.022], [seatTop, head, 0.02], [head, front, 0.016], [headLow, front, 0.016]]) g.add(tube(a, b, r, frame));
  g.add(tube(V(-0.27, 0.98, -0.42), V(0.27, 0.98, -0.42), 0.014, steel));
  g.add(tube(V(0, 0.88, -0.36), V(0, 0.98, -0.42), 0.014, steel));
  for (const x of [-0.24, 0.24]) g.add(tube(V(x, 0.98, -0.42), V(x * 1.15, 0.98, -0.42), 0.02, dark));
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.27), dark); saddle.position.set(0, 0.88, 0.2); saddle.castShadow = true; g.add(saddle);
  // the crank turns with the rear wheel
  const crank = new THREE.Group(); crank.position.copy(bb);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.03), steel); arm.position.set(s * 0.07, s * 0.08, 0); crank.add(arm);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.06), dark); pedal.position.set(s * 0.11, s * 0.16, 0); crank.add(pedal);
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.01, 6, 20), steel); ring.rotation.y = Math.PI / 2; ring.position.x = 0.05; crank.add(ring);
  g.add(crank);
  return { obj: g, wheels, crank, front: wheels[1] };
}

// a lofted open hull: stations from stern (+z) to bow (-z), each a rounded V from gunwale to keel
function hullGeometry() {
  const S = 22, K = 10, pos = [], idx = [];
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i <= S; i++) {
    const t = i / S, z = 2.4 - t * 4.9;
    const hw = 0.88 * (t < 0.55 ? 1 : Math.pow(Math.cos(((t - 0.55) / 0.45) * Math.PI / 2), 0.8)) + 0.015;
    const keel = -0.42 + 0.3 * ss(0.65, 1, t), gun = 0.42 + 0.22 * ss(0.55, 1, t);
    for (let k = 0; k <= K; k++) {
      const a = (k / K - 0.5) * Math.PI;
      pos.push(hw * Math.sin(a), keel + (gun - keel) * (1 - Math.cos(a)), z);
    }
  }
  for (let i = 0; i < S; i++) for (let k = 0; k < K; k++) {
    const a = i * (K + 1) + k, b = a + K + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // flat transom across the stern
  const c = pos.length / 3;
  pos.push(0, 0.2, 2.4);
  for (let k = 0; k < K; k++) idx.push(c, k + 1, k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeBoat(color) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(hullGeometry(), new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.1, side: THREE.DoubleSide }));
  hull.castShadow = true; hull.receiveShadow = true;
  g.add(hull);
  const wood = new THREE.MeshStandardMaterial({ color: '#9a7046', roughness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: '#f3f1ea', roughness: 0.5 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.04, 3.6), wood); deck.position.set(0, -0.12, 0.45); g.add(deck);
  for (const z of [1.3, 0.1]) { const s = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.4), white); s.position.set(0, 0.12, z); s.castShadow = true; g.add(s); }
  const screen = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.32, 0.03), new THREE.MeshPhysicalMaterial({ color: '#a9c6d6', transparent: true, opacity: 0.35, roughness: 0.05 }));
  screen.position.set(0, 0.62, -0.75); screen.rotation.x = -0.35; g.add(screen);
  const motor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.4), new THREE.MeshStandardMaterial({ color: '#202225', roughness: 0.4 })); motor.position.set(0, 0.5, 2.55); motor.castShadow = true; g.add(motor);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 8), new THREE.MeshStandardMaterial({ color: '#333' })); shaft.position.set(0, 0.0, 2.6); g.add(shaft);
  return { obj: g, wheels: [], motor };
}

// ------------------------------------------------------------------ the system
export class Vehicles {
  constructor(game) {
    this.g = game;
    this.items = new Map();        // id -> vehicle
    this.driving = null;           // the vehicle I'm in
    this.bySid = new Map();        // sid -> vehicle id they're driving
    this.carProto = null;
    loadCar().then((m) => {
      this.carProto = m;
      for (const v of this.items.values()) if (v.type === 'car') this.build(v);
    });
  }

  add(rec) {
    const it = ITEMS[rec.t];
    let v = this.items.get(rec.id);
    if (v && v === this.driving) { v.rec = rec; rec._driving = true; return; }   // a save arriving while I drive
    if (v) this.remove(rec.id);
    v = { id: rec.id, rec, type: it.vtype, T: VTYPES[it.vtype], pose: { x: rec.x, y: rec.y, z: rec.z, h: rec.ry || 0, pitch: 0, roll: 0 }, speed: 0, steer: 0, spin: 0, holder: new THREE.Group() };
    this.g.scene.add(v.holder);
    this.items.set(rec.id, v);
    this.build(v);
    this.place(v);
  }

  remove(id) {
    const v = this.items.get(id);
    if (!v) return;
    if (v === this.driving) this.exit(true);
    this.g.scene.remove(v.holder);
    this.items.delete(id);
  }

  color(v) { return v.rec.c || { car: '#b3121d', bike: '#2b7bd6', boat: '#1f4e79' }[v.type]; }

  build(v) {
    v.holder.clear();
    const col = this.color(v);
    if (v.type === 'car') {
      if (!this.carProto) { const box = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.1, 4.5), new THREE.MeshStandardMaterial({ color: col })); box.position.y = 0.55; v.holder.add(box); v.wheels = []; return; }
      const car = this.carProto.clone(true);
      const paint = new THREE.MeshPhysicalMaterial({ color: col, metalness: 0.9, roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.04 });
      car.traverse((o) => { if (o.isMesh && o.material && o.material.name === 'Body_Color') o.material = paint; });
      v.holder.add(car);
      v.wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].map((n) => car.getObjectByName(n));
      v.fronts = v.wheels.slice(0, 2);
      v.wheels.forEach((w) => { if (w) w.rotation.order = 'YXZ'; });
    } else if (v.type === 'bike') {
      const b = makeBike(col);
      v.holder.add(b.obj); v.wheels = b.wheels; v.crank = b.crank; v.fronts = [b.front]; v.bikeFrame = b.obj;
    } else {
      const b = makeBoat(col);
      v.holder.add(b.obj); v.wheels = []; v.motor = b.motor;
    }
  }

  makePreview(type) {
    const g = new THREE.Group();
    if (type === 'car') { if (this.carProto) g.add(this.carProto.clone(true)); }
    else g.add((type === 'bike' ? makeBike('#2b7bd6') : makeBoat('#f4f4f1')).obj);
    return g;
  }

  place(v) {
    const p = v.pose;
    v.holder.position.set(p.x, p.y, p.z);
    v.holder.rotation.set(p.pitch, p.h, p.roll, 'YXZ');
  }

  // ---------------------------------------------------------------- getting in and out
  driverOf(v) { for (const [sid, id] of this.bySid) if (id === v.id) return sid; return null; }

  enter(v) {
    const g = this.g;
    if (this.driverOf(v) !== null) { g.ui.toast('Someone is already driving that', 'warn'); return; }
    this.driving = v;
    v.rec._driving = true;
    v.speed = 0; v.steer = 0;
    g.player.vehicle = v;
    g.player.camDist = v.T.cam;
    g.myEmote = null; g.myAvatar.setEmote(null);
    g.ui.toast(`${v.T.verb === 'Ride' ? 'Riding' : 'Driving'} - W/S speed, A/D steer, Space brake, E to get out`);
    g.ui.setDriving(v);
    g.event('drive');
    this.seatPlayer(v);
    g.sendState(true);
  }

  exit(silent) {
    const g = this.g, v = this.driving;
    if (!v) return;
    this.driving = null;
    v.rec._driving = false;
    v.speed = 0;
    g.player.vehicle = null;
    g.ui.setDriving(null);
    // park: save the spot if it's ours to move, otherwise just show everyone where it was left
    const p = v.pose;
    const parked = { ...v.rec, x: p.x, y: p.y, z: p.z, ry: p.h };
    delete parked._pool; delete parked._driving;
    if (g.canModify(v.rec)) g.putObject(parked);
    else { v.rec = { ...v.rec, x: p.x, y: p.y, z: p.z, ry: p.h }; g.objects.set({ ...v.rec, _driving: undefined }); g.sendAction({ k: 'veh', id: v.id, x: p.x, y: p.y, z: p.z, h: p.h }); }
    // step out on the driver's side (or swim if the boat is out at sea)
    const side = new THREE.Vector3(v.T.exit[0], 0, v.T.exit[1]).applyAxisAngle(UP, p.h);
    let ex = p.x + side.x, ez = p.z + side.z;
    if (v.type === 'boat') {
      // look around for dry land or a pier to step onto
      for (let r = 2; r <= 6; r += 1) for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (g.player.groundAt(x, z, SEA + 1.5, 0) > SEA + 0.1) { ex = x; ez = z; r = 99; break; }
      }
    }
    g.player.setPosition(ex, null, ez);
    // out at sea: start swimming at the surface rather than on the sea floor
    if (g.player.pos.y < SEA - 1.2) g.player.pos.y = SEA - 1.3;
    g.player.heading = p.h;
    g.sound.engine(null, 0);
    if (!silent) g.sendState(true);
  }

  seatPlayer(v) {
    this.g.myAvatar.rideSpeed = Math.abs(v.speed);
    const p = v.pose, s = v.T.seat;
    const off = new THREE.Vector3(s[0], 0, s[2]).applyAxisAngle(UP, p.h);
    this.g.player.pos.set(p.x + off.x, p.y + s[1] + (v.type === 'boat' ? v.bob || 0 : 0), p.z + off.z);
    this.g.player.heading = p.h;
  }

  // ---------------------------------------------------------------- physics
  groundY(x, z, refY, step) {
    return this.g.player.groundAt(x, z, refY + step, 0);
  }

  // can a land vehicle stand here? (dry enough and no wall)
  landOk(v, x, z, refY) {
    const t = this.g.terrain.heightAt(x, z);
    const y = this.groundY(x, z, refY, v.T.step);
    if (y < SEA - 0.35 && t < SEA - 0.35) return null;     // deep water
    return y;
  }

  drive(dt) {
    const v = this.driving, g = this.g, p = v.pose, T = v.T, keys = g.player;
    const typing = g.ui.isTyping();
    const k = (...c) => !typing && keys.key(...c);
    const throttle = k('KeyW', 'ArrowUp') ? 1 : 0, back = k('KeyS', 'ArrowDown') ? 1 : 0;
    const steerIn = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    const brake = k('Space');
    // speed
    if (throttle) v.speed += (v.speed < 0 ? T.brake : T.accel) * dt;
    if (back) v.speed -= (v.speed > 0 ? T.brake : T.accel * 0.6) * dt;
    if (brake) v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), T.brake * 1.3 * dt);
    if (!throttle && !back) v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), (T.drag + Math.abs(v.speed) * 0.03) * 2 * dt);
    v.speed = Math.max(-T.maxR, Math.min(T.maxF, v.speed));
    // steering: the wheels turn less at speed so it stays controllable
    const target = steerIn * T.steerMax / (1 + Math.abs(v.speed) * (v.type === 'bike' ? 0.08 : 0.18));
    v.steer += (target - v.steer) * Math.min(1, dt * 6);
    const yawRate = (v.speed / T.wb) * Math.tan(v.steer);
    const nh = p.h + yawRate * dt;
    const fx = -Math.sin(nh), fz = -Math.cos(nh);
    let nx = p.x + fx * v.speed * dt, nz = p.z + fz * v.speed * dt;
    const lim = HALF + 380;
    nx = Math.max(-lim, Math.min(lim, nx)); nz = Math.max(-lim, Math.min(lim, nz));

    if (T.medium === 'water') {
      // the bow must stay in water deep enough to float
      const bowX = nx + fx * 2.4 * Math.sign(v.speed || 1), bowZ = nz + fz * 2.4 * Math.sign(v.speed || 1);
      const deep = (x, z) => g.terrain.heightAt(x, z) < SEA - 0.55 && g.player.groundAt(x, z, SEA + 0.4, 0) < SEA;
      if (!deep(bowX, bowZ) || !deep(nx, nz)) { this.bump(v); return; }
      p.x = nx; p.z = nz; p.h = nh;
      const t = performance.now() / 1000;
      v.bob = Math.sin(t * 1.6 + p.x * 0.05) * 0.06;
      p.y = SEA + 0.12 + v.bob;
      p.pitch = -Math.min(0.14, Math.abs(v.speed) / T.maxF * 0.14) + Math.sin(t * 1.3) * 0.02;
      p.roll = -v.steer * Math.abs(v.speed) / T.maxF * 0.25 + Math.sin(t * 1.1 + 1) * 0.025;
    } else {
      // sample the ground under the front and rear wheels
      const half = T.wb / 2;
      const fy = this.landOk(v, nx + fx * half, nz + fz * half, p.y);
      const ry = this.landOk(v, nx - fx * half, nz - fz * half, p.y);
      if (fy === null || ry === null) { this.bump(v); return; }
      // a step too tall (a wall, a kerb higher than the wheels) stops you
      if (fy - p.y > T.step + 0.2 || ry - p.y > T.step + 0.2) { this.bump(v); return; }
      // solid things in the way: walls, buildings, trees (two circles along the body for the car)
      const circles = v.type === 'car' ? [half * 0.9, -half * 0.9] : [0];
      for (const c of circles) if (this.hits(v, nx + fx * c, nz + fz * c, (fy + ry) / 2)) { this.bump(v); return; }
      p.x = nx; p.z = nz; p.h = nh;
      const y = (fy + ry) / 2;
      p.y += (y - p.y) * Math.min(1, dt * 12);
      p.pitch = Math.atan2(fy - ry, T.wb);
      if (v.type === 'car') {
        const sx = -fz * T.track / 2, sz = fx * T.track / 2;
        const ly = this.groundY(nx + sx, nz + sz, p.y, T.step), rr = this.groundY(nx - sx, nz - sz, p.y, T.step);
        p.roll += (Math.atan2(ly - rr, T.track) * 0.8 - p.roll) * Math.min(1, dt * 8);
      } else {
        // a bike leans into its turns
        p.roll += (v.steer * Math.min(1, Math.abs(v.speed) / 4) * 0.55 - p.roll) * Math.min(1, dt * 6);
      }
    }
  }

  hits(v, x, z, y) {
    const g = this.g, r = v.T.radius;
    for (const { rec, col } of g.objects.colliders(x, z, r + 2)) {
      if (rec.id === v.id || col.r) continue;
      const b = g.player.colBox(rec, col);
      if (b.cy + b.hy <= y + v.T.step || b.cy - b.hy >= y + 1.4) continue;     // drive over it / under it
      const [lx, lz] = g.player.toLocal(rec, x, z);
      const qx = Math.max(b.cx - b.hx, Math.min(lx, b.cx + b.hx)), qz = Math.max(b.cz - b.hz, Math.min(lz, b.cz + b.hz));
      if (Math.hypot(lx - qx, lz - qz) < r) return true;
    }
    for (const t of g.trees.near(x, z, r + 1)) {
      const tr = g.trees.trunkRadius(t);
      if (tr && Math.hypot(t.x - x, t.z - z) < tr + r) return true;
    }
    // other vehicles
    for (const o of this.items.values()) if (o !== v && Math.hypot(o.pose.x - x, o.pose.z - z) < r + o.T.radius && o.type !== 'boat') return true;
    return false;
  }

  bump(v) {
    const now = performance.now();
    if (Math.abs(v.speed) > 4 && now - (this.bumpedAt || 0) > 600) { this.bumpedAt = now; this.g.sound.thud(Math.abs(v.speed) / v.T.maxF); }
    v.speed *= -0.25;
  }

  // ---------------------------------------------------------------- network
  // what the driver sends with their position: [id, x, y, z, heading, pitch, roll, speed, steer]
  stateFor() {
    const v = this.driving;
    if (!v) return null;
    const p = v.pose, r = (n) => Math.round(n * 100) / 100;
    return [v.id, r(p.x), r(p.y), r(p.z), r(p.h), r(p.pitch), r(p.roll), r(v.speed), r(v.steer)];
  }

  remoteState(sid, vh) {
    if (!vh) {
      // they got out: the vehicle stays where they left it until the saved record or action says otherwise
      if (this.bySid.has(sid)) { const v = this.items.get(this.bySid.get(sid)); if (v) { v.speed = 0; v.remote = null; } this.bySid.delete(sid); }
      return;
    }
    const v = this.items.get(vh[0]);
    if (!v || v === this.driving) return;
    this.bySid.set(sid, v.id);
    v.remote = { x: vh[1], y: vh[2], z: vh[3], h: vh[4], pitch: vh[5], roll: vh[6] };
    v.speed = vh[7]; v.steer = vh[8];
    const pl = this.g.players.get(sid);
    if (pl) pl.avatar.rideSpeed = Math.abs(v.speed);
  }

  onAction(a) {
    const v = this.items.get(a.id);
    if (!v || v === this.driving) return;
    Object.assign(v.pose, { x: a.x, y: a.y, z: a.z, h: a.h, pitch: 0, roll: 0 });
    v.rec = { ...v.rec, x: a.x, y: a.y, z: a.z, ry: a.h };
    this.g.objects.set({ ...v.rec });
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    const g = this.g;
    if (this.driving) {
      this.drive(dt);
      this.seatPlayer(this.driving);
      g.sound.engine(this.driving.type, Math.abs(this.driving.speed) / this.driving.T.maxF);
    }
    const cam = g.camera.position;
    for (const v of this.items.values()) {
      if (v.remote) {
        // ease toward the driver's last reported pose
        const p = v.pose, r = v.remote, k = Math.min(1, dt * 10);
        p.x += (r.x - p.x) * k; p.y += (r.y - p.y) * k; p.z += (r.z - p.z) * k;
        p.h += wrap(r.h - p.h) * k; p.pitch += (r.pitch - p.pitch) * k; p.roll += (r.roll - p.roll) * k;
      } else if (v.type === 'boat' && v !== this.driving) {
        // moored boats still rock on the waves
        const t = performance.now() / 1000;
        v.pose.y = SEA + 0.12 + Math.sin(t * 1.6 + v.pose.x * 0.05) * 0.06;
        v.pose.roll = Math.sin(t * 1.1 + v.pose.z) * 0.03;
      }
      if ((v.pose.x - cam.x) ** 2 + (v.pose.z - cam.z) ** 2 > 400 * 400) { v.holder.visible = false; continue; }
      v.holder.visible = true;
      this.place(v);
      // wheels roll, front wheels steer, pedals turn
      if (v.T.r) v.spin = (v.spin + (v.speed / v.T.r) * dt) % (Math.PI * 2);
      if (v.type === 'car') {
        v.wheels.forEach((w) => { if (w) w.rotation.x = -v.spin; });
        (v.fronts || []).forEach((w) => { if (w) w.rotation.y = v.steer; });
      } else if (v.type === 'bike') {
        v.wheels.forEach((w) => { w.rotation.x = -v.spin; });
        if (v.fronts[0]) v.fronts[0].rotation.y = v.steer * 0.8;
        if (v.crank) v.crank.rotation.x = -v.spin * 0.5;
      }
    }
  }
}
