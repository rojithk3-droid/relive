// The local player: keyboard movement relative to the camera, a vertical-capsule body that walks up
// stairs/ramps/roofs and stands on anything built, swimming, a fly mode for builders, and an orbit camera
// (right-drag to look around, wheel to zoom) that pulls in rather than clipping through walls.
import * as THREE from 'three';
import { HALF, SEA } from './config.js';
import { ITEMS } from './catalog.js';

const RADIUS = 0.32, HEIGHT = 1.75, STEP = 0.55, GRAV = 22;

export class Player {
  constructor(camera, dom, terrain, objects, trees) {
    this.camera = camera;
    this.dom = dom;
    this.terrain = terrain;
    this.objects = objects;
    this.trees = trees;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.camYaw = 0;
    this.camPitch = -0.28;
    this.camDist = 7;
    this.camTarget = new THREE.Vector3();
    this.flying = false;
    this.onGround = false;
    this.mode = 'walk';
    this.speed = 0;
    this.keys = new Set();
    this.dragging = false;
    this.inputEnabled = true;
    this.sitting = false;
    // free camera: detached from the avatar, flies over the land for building (WASD pans the focus point)
    this.freeCam = false;
    this.focus = new THREE.Vector3();
    this.focusGoal = null;          // smooth glide target for the focus
    this.qeOrbit = false;           // Q/E orbit the free camera when no build tool wants them
    this.camDistSmooth = 7;
    this.settings = { sens: 1, invertY: false };
    this.bind();
  }

  bind() {
    addEventListener('keydown', (e) => {
      if (!this.inputEnabled || e.target.closest('input, textarea, select')) return;
      this.keys.add(e.code);
      if (e.code === 'KeyF' && !e.ctrlKey && !this.freeCam && !this.vehicle) { this.flying = !this.flying; this.vel.y = 0; this.onToggleFly && this.onToggleFly(this.flying); }
      if (e.code === 'KeyV' && !e.ctrlKey) this.setFreeCam(!this.freeCam);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    let lx = 0, ly = 0;
    this.dom.addEventListener('pointerdown', (e) => {
      // right button, or left button with Alt, orbits the camera; plain left-drag orbits in explore mode;
      // the middle button pans (and switches to the free camera)
      if (e.button === 2 || e.button === 1 || (e.button === 0 && (e.altKey || this.leftDragOrbits))) {
        if (e.button === 1) { e.preventDefault(); if (!this.freeCam) this.setFreeCam(true); }
        this.dragging = true; this.panning = e.button === 1 || (e.button === 2 && e.shiftKey);
        this.dragMoved = 0; lx = e.clientX; ly = e.clientY;
        this.dom.setPointerCapture(e.pointerId);
      }
    });
    this.dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      if (this.panning && this.freeCam) {
        // drag the ground under the cursor: move the focus against the drag, scaled by how far out we are
        const k = this.camDist * 0.0022;
        const cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
        this.focus.x -= (dx * cy + dy * sy) * k;
        this.focus.z -= (-dx * sy + dy * cy) * k;
        this.focusGoal = null;
        return;
      }
      this.camYaw -= dx * 0.005 * this.settings.sens;
      this.camPitch -= dy * 0.004 * this.settings.sens * (this.settings.invertY ? -1 : 1);
      this.camPitch = THREE.MathUtils.clamp(this.camPitch, -1.5, 1.2);
    });
    const end = (e) => { if (this.dragging) { this.dragging = false; try { this.dom.releasePointerCapture(e.pointerId); } catch { } } };
    this.dom.addEventListener('pointerup', end);
    this.dom.addEventListener('pointercancel', end);
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    this.dom.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll on middle-drag
    this.dom.addEventListener('wheel', (e) => {
      if (this.wheelBlocked && this.wheelBlocked(e)) return;
      this.camDist = THREE.MathUtils.clamp(this.camDist * (e.deltaY > 0 ? 1.12 : 0.89), this.freeCam ? 3 : 0.6, this.freeCam ? 320 : 120);
    }, { passive: true });
  }

  // opts: { at: Vector3 to glide to, dist, pitch }
  setFreeCam(on, opts = {}) {
    if (on && !this.freeCam) {
      this.focus.set(this.pos.x, this.pos.y + 1, this.pos.z);
      this.savedCam = { dist: this.camDist, pitch: this.camPitch };
    }
    if (!on && this.freeCam && this.savedCam) { this.camDist = this.savedCam.dist; this.camPitch = this.savedCam.pitch; }
    this.freeCam = on;
    if (on) {
      if (opts.dist) this.camDist = opts.dist; else if (this.camDist < 14) this.camDist = 22;
      if (opts.pitch !== undefined) this.camPitch = opts.pitch; else if (this.camPitch > -0.35) this.camPitch = -0.55;
      if (opts.at) this.focusGoal = opts.at.clone();
    }
    this.vel.x = this.vel.z = 0;
    this.onFreeCam && this.onFreeCam(on);
  }

  // WASD / arrows move the free camera's focus across the land, Q/E orbit, wheel zooms
  updateFreeCam(dt, inputActive) {
    if (inputActive && this.inputEnabled) {
      let ix = 0, iz = 0;
      if (this.key('KeyW', 'ArrowUp')) iz -= 1;
      if (this.key('KeyS', 'ArrowDown')) iz += 1;
      if (this.key('KeyA', 'ArrowLeft')) ix -= 1;
      if (this.key('KeyD', 'ArrowRight')) ix += 1;
      const len = Math.hypot(ix, iz);
      if (len) {
        const sp = (6 + this.camDist * 0.7) * (this.key('ShiftLeft', 'ShiftRight') ? 2.5 : 1) * dt / len;
        const cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
        this.focus.x += (ix * cy + iz * sy) * sp;
        this.focus.z += (-ix * sy + iz * cy) * sp;
        this.focusGoal = null;
      }
      if (this.qeOrbit) {
        if (this.key('KeyQ')) this.camYaw += dt * 1.5;
        if (this.key('KeyE')) this.camYaw -= dt * 1.5;
      }
    }
    if (this.focusGoal) {
      this.focus.lerp(this.focusGoal, Math.min(1, dt * 4));
      if (this.focus.distanceTo(this.focusGoal) < 0.05) this.focusGoal = null;
    }
    const lim = HALF + 300;
    this.focus.x = THREE.MathUtils.clamp(this.focus.x, -lim, lim);
    this.focus.z = THREE.MathUtils.clamp(this.focus.z, -lim, lim);
    // ride along the ground (or the water surface)
    const g = Math.max(this.terrain.heightAt(this.focus.x, this.focus.z), SEA) + 1;
    if (!this.focusGoal) this.focus.y += (g - this.focus.y) * Math.min(1, dt * 5);
  }

  setPosition(x, y, z) {
    this.seat = null;
    this.sitting = false;
    // land on the ground or a ground-floor slab, never on a roof
    this.pos.set(x, y ?? this.groundAt(x, z, this.terrain.heightAt(x, z) + 1.2, 0), z);
    this.vel.set(0, 0, 0);
  }

  key(...codes) { return codes.some((c) => this.keys.has(c)); }

  // highest walkable surface under (x,z) not more than `reach` above the feet
  groundAt(x, z, feetY, reach = STEP) {
    let g = this.terrain.heightAt(x, z);
    for (const { rec, col } of this.objects.colliders(x, z, 1)) {
      const top = this.surfaceTop(rec, col, x, z, RADIUS * 0.6);
      if (top !== null && top <= feetY + reach && top > g) g = top;
    }
    return g;
  }

  // in the record's yaw-rotated frame (metres, scale applied)
  toLocal(rec, x, z) {
    const dx = x - rec.x, dz = z - rec.z, c = Math.cos(rec.ry), s = Math.sin(rec.ry);
    return [dx * c - dz * s, dx * s + dz * c];
  }

  colBox(rec, col) {
    const v = col.b || col.r, s = rec.s;
    return { cx: v[0] * s[0], cy: v[1] * s[1] + rec.y, cz: v[2] * s[2], hx: v[3] * s[0], hy: v[4] * s[1], hz: v[5] * s[2] };
  }

  surfaceTop(rec, col, x, z, pad) {
    const b = this.colBox(rec, col);
    const [lx, lz] = this.toLocal(rec, x, z);
    if (Math.abs(lx - b.cx) > b.hx + pad || Math.abs(lz - b.cz) > b.hz + pad) return null;
    if (col.b) return b.cy + b.hy;
    // ramp: height rises along local z (dir +1) or falls (dir -1)
    const t = THREE.MathUtils.clamp((lz - (b.cz - b.hz)) / (2 * b.hz), 0, 1);
    return b.cy - b.hy + 2 * b.hy * (col.dir > 0 ? t : 1 - t);
  }

  // sit on a seat: the feet go where the hips need to be for the sitting pose, facing out of the seat
  sitAt(x, y, z, heading) {
    this.seat = { x, y, z, heading, from: this.pos.clone() };
    this.pos.set(x, y, z);
    this.heading = heading;
    this.vel.set(0, 0, 0);
    this.sitting = true;
    this.mode = 'sit';
  }

  standUp() {
    const s = this.seat;
    this.seat = null;
    this.sitting = false;
    // step off the seat toward where we came from (always somewhere we could stand)
    this.pos.copy(s.from);
  }

  update(dt, inputActive = true) {
    dt = Math.min(dt, 0.05);
    // with the free camera on, the keys drive the camera and the avatar just stands where it is
    if (this.freeCam) { this.updateFreeCam(dt, inputActive); inputActive = false; }
    // in a vehicle: the vehicle system moves us (and reads the keys itself)
    if (this.vehicle) { this.vel.set(0, 0, 0); this.speed = 0; this.mode = this.vehicle.type === 'bike' ? 'ride' : 'drive'; this.onGround = true; this.flying = false; return; }
    if (this.seat) {
      const moving = inputActive && this.inputEnabled && this.key('KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space');
      if (!moving) { this.pos.set(this.seat.x, this.seat.y, this.seat.z); this.heading = this.seat.heading; this.speed = 0; this.mode = 'sit'; return; }
      this.standUp();
    }
    // ---- desired horizontal velocity from keys, relative to the camera
    let ix = 0, iz = 0;
    if (inputActive && this.inputEnabled) {
      if (this.key('KeyW', 'ArrowUp')) iz -= 1;
      if (this.key('KeyS', 'ArrowDown')) iz += 1;
      if (this.key('KeyA', 'ArrowLeft')) ix -= 1;
      if (this.key('KeyD', 'ArrowRight')) ix += 1;
    }
    const run = this.key('ShiftLeft', 'ShiftRight');
    const len = Math.hypot(ix, iz);
    if (len) { ix /= len; iz /= len; this.sitting = false; }
    const cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
    const mx = ix * cy + iz * sy, mz = -ix * sy + iz * cy;
    const ground0 = this.terrain.heightAt(this.pos.x, this.pos.z);
    const swimming = !this.flying && this.pos.y < SEA - 1.15 && ground0 < SEA - 1.2;
    let speed = this.flying ? (run ? 32 : 12) : swimming ? (run ? 3 : 1.8) : run ? 6.8 : 3.0;
    const tvx = mx * speed, tvz = mz * speed;
    const accel = this.onGround || this.flying || swimming ? 12 : 3;
    this.vel.x += (tvx - this.vel.x) * Math.min(1, dt * accel);
    this.vel.z += (tvz - this.vel.z) * Math.min(1, dt * accel);
    if (len) this.heading = Math.atan2(-mx, -mz);

    // ---- vertical
    if (this.flying) {
      let vy = 0;
      if (inputActive && this.key('Space')) vy += 1;
      if (inputActive && this.key('KeyC', 'ControlLeft')) vy -= 1;
      this.vel.y += (vy * speed - this.vel.y) * Math.min(1, dt * 10);
    } else if (swimming) {
      const float = SEA - 1.32;
      this.vel.y += (float - this.pos.y) * dt * 8 - this.vel.y * dt * 3;
      if (inputActive && this.key('Space') && this.pos.y > float - 0.2) this.vel.y = 4;
    } else {
      this.vel.y -= GRAV * dt;
      if (inputActive && this.key('Space') && this.onGround) { this.vel.y = 7.2; this.onGround = false; }
    }

    // ---- integrate + collide
    const p = this.pos;
    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;
    this.collideHorizontal();
    p.y += this.vel.y * dt;

    const ground = this.groundAt(p.x, p.z, p.y, this.onGround ? STEP : 0.25);
    // ceilings: stop when the head meets the underside of something
    if (this.vel.y > 0) {
      for (const { rec, col } of this.objects.colliders(p.x, p.z, 1)) {
        if (!col.b) continue;
        const b = this.colBox(rec, col), [lx, lz] = this.toLocal(rec, p.x, p.z);
        if (Math.abs(lx - b.cx) > b.hx || Math.abs(lz - b.cz) > b.hz) continue;
        const bottom = b.cy - b.hy;
        if (p.y < bottom && p.y + HEIGHT > bottom) { p.y = bottom - HEIGHT; this.vel.y = 0; }
      }
    }
    if (p.y <= ground + 0.001) {
      // smooth stair climbing instead of popping up
      if (ground - p.y > 0.05 && this.onGround) p.y += Math.min(ground - p.y, dt * 9);
      else p.y = ground;
      if (this.vel.y < 0) this.vel.y = 0;
      this.onGround = !this.flying;
      if (this.flying && ground - p.y > -0.01 && this.vel.y < 0) this.vel.y = 0;
    } else {
      // stick to slopes/stairs while walking down
      this.onGround = !this.flying && this.onGround && p.y - ground < 0.35 && this.vel.y <= 0;
      if (this.onGround) p.y = ground;
    }
    const lim = HALF + 400;
    p.x = THREE.MathUtils.clamp(p.x, -lim, lim);
    p.z = THREE.MathUtils.clamp(p.z, -lim, lim);
    if (p.y < -60) this.setPosition(0, null, 70);

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.mode = this.flying ? 'fly' : swimming ? 'swim' : this.sitting ? 'sit' : this.speed > 4 ? 'run' : 'walk';
  }

  collideHorizontal() {
    const p = this.pos;
    for (let iter = 0; iter < 2; iter++) {
      for (const { rec, col } of this.objects.colliders(p.x, p.z, 2)) {
        const b = this.colBox(rec, col);
        // stepping onto it, or passing underneath it, is not a collision
        const top = col.b ? b.cy + b.hy : null;
        if (col.r) continue; // ramps are walked on, never pushed against
        if (top <= p.y + STEP) continue;
        if (b.cy - b.hy >= p.y + HEIGHT) continue;
        const [lx, lz] = this.toLocal(rec, p.x, p.z);
        const qx = THREE.MathUtils.clamp(lx, b.cx - b.hx, b.cx + b.hx), qz = THREE.MathUtils.clamp(lz, b.cz - b.hz, b.cz + b.hz);
        let dx = lx - qx, dz = lz - qz, d = Math.hypot(dx, dz);
        if (d >= RADIUS) continue;
        let push;
        if (d < 1e-5) {
          // centre inside the box: leave along the shallowest axis
          const px = b.hx - Math.abs(lx - b.cx), pz = b.hz - Math.abs(lz - b.cz);
          if (px < pz) { dx = Math.sign(lx - b.cx) || 1; dz = 0; push = px + RADIUS; } else { dz = Math.sign(lz - b.cz) || 1; dx = 0; push = pz + RADIUS; }
        } else { dx /= d; dz /= d; push = RADIUS - d; }
        // back to world
        const c = Math.cos(rec.ry), s = Math.sin(rec.ry);
        p.x += (dx * c + dz * s) * push;
        p.z += (-dx * s + dz * c) * push;
      }
    }
    // tree trunks
    for (const t of this.trees.near(p.x, p.z, 3)) {
      const r = this.trees.trunkRadius(t);
      if (!r) continue;
      const dx = p.x - t.x, dz = p.z - t.z, d = Math.hypot(dx, dz), min = r + RADIUS;
      if (d < min && d > 1e-4 && p.y < t.y + 6) { p.x += (dx / d) * (min - d); p.z += (dz / d) * (min - d); }
    }
  }

  updateCamera(dt) {
    const eye = this.camDist < 1 ? 1.62 : 1.55;
    const veh = this.vehicle && !this.freeCam ? this.vehicle : null;
    const target = this.freeCam ? this.camTarget.copy(this.focus)
      : veh ? this.camTarget.set(veh.pose.x, veh.pose.y + veh.T.camH, veh.pose.z)
      : this.camTarget.set(this.pos.x, this.pos.y + eye, this.pos.z);
    // chase camera: swing in behind the vehicle unless the player is looking around with the mouse
    if (veh) {
      if (this.dragging) this.lastLook = performance.now();
      if (performance.now() - (this.lastLook || 0) > 1500 && Math.abs(veh.speed) > 0.5) {
        const behind = veh.pose.h + (veh.speed < -0.5 ? Math.PI : 0);
        const d = Math.atan2(Math.sin(behind - this.camYaw), Math.cos(behind - this.camYaw));
        this.camYaw += d * Math.min(1, dt * 2.5);
        this.camPitch += (-0.18 - this.camPitch) * Math.min(1, dt * 1.5);
      }
    }
    const cp = Math.cos(this.camPitch);
    const dir = new THREE.Vector3(Math.sin(this.camYaw) * cp, -Math.sin(this.camPitch), Math.cos(this.camYaw) * cp);
    let dist = this.camDist;
    if (dist > 1 && !this.freeCam) {
      // pull in if a wall is in the way (fast), ease back out once it's clear (slow) so rooms don't jitter
      const hit = this.objects.pick(new THREE.Ray(target.clone(), dir.clone()), dist + 0.5);
      if (hit && hit.dist < dist) dist = Math.max(0.6, hit.dist - 0.3);
    }
    const k = dist < this.camDistSmooth ? 1 - Math.exp(-dt * 25) : 1 - Math.exp(-dt * 4);
    this.camDistSmooth += (dist - this.camDistSmooth) * (dt > 0 ? k : 1);
    dist = this.camDistSmooth;
    const cam = this.camera;
    cam.position.copy(target).addScaledVector(dir, dist);
    const g = this.terrain.heightAt(cam.position.x, cam.position.z) + 0.4;
    if (cam.position.y < g) cam.position.y = g;
    cam.lookAt(target);
    // first person: hide nothing, the camera simply sits at the eyes and looks ahead
    if (this.camDist < 1 && !this.freeCam) {
      cam.position.copy(target);
      cam.lookAt(target.clone().addScaledVector(dir, -5));
    }
  }

  // network snapshot of this player
  snapshot() {
    const r = (v) => Math.round(v * 100) / 100;
    return { x: r(this.pos.x), y: r(this.pos.y), z: r(this.pos.z), h: r(this.heading), v: r(this.speed), m: this.mode };
  }
}

export function itemLabel(t) { return ITEMS[t] ? ITEMS[t].label : t; }
