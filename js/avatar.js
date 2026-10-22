// A person in the world: rigged body, walk/run blending, a floating name tag with speech bubbles, and
// procedural emotes (wave, cheer, point, clap, dance, sit) posed by aiming bones in world space, so they
// work on any Mixamo-style skeleton without extra animation files.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadBody, BODIES } from './assets.js';

const UP = new THREE.Vector3(0, 1, 0);
const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3();

// joints by name; end markers like HeadTop_End are plain nodes in some rigs, so any node counts
function findBone(root, suffix) {
  let hit = null;
  root.traverse((o) => { if (!hit && (o.isBone || o.type === 'Object3D') && o.name.replace(/[^A-Za-z]/g, '').endsWith(suffix)) hit = o; });
  return hit;
}

// rotate `bone` so the direction toward `child` points along `dir` (world space), blended by w
function aim(bone, child, dir, w) {
  if (!bone || !child || w <= 0) return;
  bone.updateWorldMatrix(true, true);
  const a = bone.getWorldPosition(tv), b = child.getWorldPosition(tv2);
  const cur = b.sub(a).normalize();
  tq.setFromUnitVectors(cur, dir.clone().normalize());
  bone.getWorldQuaternion(tq2);
  const target = tq.multiply(tq2);
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.slerp(parentQ.multiply(target), w);
  bone.updateWorldMatrix(false, true);
}

// ------------------------------------------------------------------ accessories
export const HATS = { none: 'No hat', cap: 'Cap', beanie: 'Beanie', tophat: 'Top hat', cowboy: 'Cowboy hat', sunhat: 'Sun hat', crown: 'Crown', flowers: 'Flower crown' };

function makeHat(kind, color) {
  if (!kind || kind === 'none' || !HATS[kind]) return null;
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const g = new THREE.Group();
  const add = (geo, mat = m, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
  const dome = (r, sy = 1) => { const d = new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2); d.scale(1, sy, 1.08); return d; };
  switch (kind) {
    case 'cap': add(dome(0.118, 0.8)); { const b = add(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 16, 1, false, -Math.PI / 2 - 0.9, 1.8), m, 0, 0.005, -0.09); b.scale.set(1.1, 1, 1.1); } break;
    case 'beanie': add(dome(0.122, 1.1)); add(new THREE.TorusGeometry(0.118, 0.022, 8, 24).rotateX(Math.PI / 2), m, 0, 0.012, 0); break;
    case 'tophat': add(new THREE.CylinderGeometry(0.1, 0.105, 0.22, 20), m, 0, 0.12, 0); add(new THREE.CylinderGeometry(0.175, 0.175, 0.014, 24), m, 0, 0.01, 0); add(new THREE.CylinderGeometry(0.106, 0.106, 0.035, 20), new THREE.MeshStandardMaterial({ color: '#7a1f1f' }), 0, 0.035, 0); break;
    case 'cowboy': add(dome(0.12, 0.95)); { const b = add(new THREE.CylinderGeometry(0.24, 0.24, 0.016, 24), m, 0, 0.012, 0); b.scale.set(1, 1, 1.1); } break;
    case 'sunhat': { const straw = new THREE.MeshStandardMaterial({ color: '#d8c08a', roughness: 0.9 }); add(dome(0.12, 0.7), straw); add(new THREE.CylinderGeometry(0.28, 0.28, 0.01, 28), straw, 0, 0.01, 0); add(new THREE.TorusGeometry(0.12, 0.012, 6, 24).rotateX(Math.PI / 2), m, 0, 0.03, 0); } break;
    case 'crown': {
      const gold = new THREE.MeshStandardMaterial({ color: '#e7b93a', metalness: 1, roughness: 0.25 });
      add(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 20, 1, true), gold, 0, 0.04, 0).material.side = THREE.DoubleSide;
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; add(new THREE.ConeGeometry(0.022, 0.07, 6), gold, Math.cos(a) * 0.105, 0.105, Math.sin(a) * 0.105); add(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshStandardMaterial({ color: ['#d12e2e', '#2e6bd1', '#2ed16b'][i % 3], roughness: 0.2 }), Math.cos(a) * 0.112, 0.045, Math.sin(a) * 0.112); }
      break;
    }
    case 'flowers': {
      add(new THREE.TorusGeometry(0.115, 0.012, 6, 24).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#4f7f2e' }), 0, 0.02, 0);
      const cols = ['#e8679a', '#f2c21b', '#ffffff', '#9a6ad6', color];
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; add(new THREE.SphereGeometry(0.026, 8, 6), new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.6 }), Math.cos(a) * 0.118, 0.03, Math.sin(a) * 0.118); }
      break;
    }
  }
  return g;
}

function makeGlasses() {
  const m = new THREE.MeshStandardMaterial({ color: '#1b1b1d', roughness: 0.3, metalness: 0.4 });
  const lens = new THREE.MeshPhysicalMaterial({ color: '#223', roughness: 0.05, transparent: true, opacity: 0.55 });
  const g = new THREE.Group();
  for (const x of [-0.034, 0.034]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.004, 6, 18), m); rim.position.x = x; g.add(rim);
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.025, 18), lens); l.position.set(x, 0, -0.001); l.rotation.y = Math.PI; g.add(l);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.004, 0.004), m); g.add(bridge);
  return g;
}

export class Avatar {
  // opts.noShadow: background characters (townspeople) skip the shadow pass, which halves their cost
  constructor(scene, profile, opts = {}) {
    this.scene = scene;
    this.noShadow = !!opts.noShadow;
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    scene.add(this.group);
    this.anim = 'idle';
    this.emote = null;
    this.emoteT = 0;
    this.emoteW = 0;
    this.sitW = 0;
    this.driveW = 0;
    this.heading = 0;
    this.tag = document.createElement('div');
    this.tag.className = 'nametag';
    this.tag.innerHTML = '<div class="bubbles"></div><div class="nm"></div>';
    this.label = new CSS2DObject(this.tag);
    this.label.position.set(0, 2.05, 0);
    this.group.add(this.label);
    this.setProfile(profile);
  }

  async setProfile(p) {
    this.profile = p;
    this.tag.querySelector('.nm').textContent = p.name || 'Guest';
    this.group.scale.setScalar(Math.min(1.15, Math.max(0.85, p.height || 1)));
    this.buildAccessories();
    const kind = BODIES[p.body] ? p.body : 'soldier';
    if (this.kind === kind && this.model) { this.applyTint(); return; }
    this.kind = kind;
    const src = await loadBody(kind);
    if (!src || this.disposed || this.kind !== kind) return;
    if (this.model) this.group.remove(this.model);
    this.model = SkeletonUtils.clone(src.scene);
    this.model.rotation.y = src.def.yaw;
    this.model.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.userData.baseColor = o.material.color.clone(); o.castShadow = !this.noShadow; } });
    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const [k, name] of Object.entries(src.def.clips)) {
      const clip = src.animations.find((c) => c.name === name);
      if (clip) { const a = this.mixer.clipAction(clip); a.play(); a.weight = k === 'idle' ? 1 : 0; this.actions[k] = a; }
    }
    this.bones = {};
    for (const n of ['Hips', 'Spine', 'Spine2', 'Head', 'HeadTopEnd', 'RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftUpLeg', 'LeftLeg', 'LeftFoot']) this.bones[n] = findBone(this.model, n);
    this.applyTint();
  }

  applyTint() {
    if (!this.model) return;
    const c = new THREE.Color(this.profile.color || '#ffffff');
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      // tint the clothing/body surface, keep visors and joints as they are
      const n = (o.material.name || '').toLowerCase();
      if (n.includes('visor') || n.includes('joint')) return;
      o.material.color.copy(o.userData.baseColor).multiply(c);
    });
  }

  // hats and glasses ride on the head: rebuilt when the profile changes, positioned every frame
  buildAccessories() {
    if (this.acc) { this.group.remove(this.acc.hat, this.acc.glasses); }
    const p = this.profile;
    const hat = makeHat(p.hat, p.hatColor || '#3a5a8c');
    const glasses = p.glasses ? makeGlasses() : null;
    this.acc = { hat, glasses };
    if (hat) this.group.add(hat);
    if (glasses) this.group.add(glasses);
  }

  placeAccessories() {
    if (!this.acc || !this.bones || (!this.acc.hat && !this.acc.glasses)) return;
    const top = this.bones.HeadTopEnd, head = this.bones.Head;
    if (!top || !head) return;
    // only the chain from the root to the head needs fresh matrices, not the whole skeleton
    top.updateWorldMatrix(true, false);
    const tp = this.group.worldToLocal(top.getWorldPosition(tv));
    const hp = this.group.worldToLocal(head.getWorldPosition(tv2));
    if (this.acc.hat) this.acc.hat.position.set(tp.x, tp.y - 0.07, tp.z);
    if (this.acc.glasses) this.acc.glasses.position.set(hp.x, hp.y + 0.09, hp.z - 0.1);
  }

  setSpeaking(on) { if (this.speaking !== on) { this.speaking = on; this.tag.classList.toggle('speaking', on); } }

  say(text) {
    const box = this.tag.querySelector('.bubbles');
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text.length > 140 ? text.slice(0, 137) + '…' : text;
    box.appendChild(b);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { b.classList.add('fade'); setTimeout(() => b.remove(), 600); }, 7000);
  }

  setEmote(e) { this.emote = e || null; this.emoteT = 0; }

  // pos: feet position; heading: yaw; speed: m/s on the ground; mode: walk|run|swim|fly|sit
  update(dt, pos, heading, speed, mode) {
    this.group.position.copy(pos);
    // shortest-arc turn toward the heading
    let d = heading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * 10);
    this.group.rotation.y = this.heading;
    if (!this.mixer) return;
    const moving = speed > 0.3;
    const runW = THREE.MathUtils.clamp((speed - 3.4) / 2.5, 0, 1);
    const walkW = moving ? 1 - runW : 0;
    const target = { idle: moving ? 0 : 1, walk: walkW, run: moving ? runW : 0 };
    for (const [k, a] of Object.entries(this.actions)) {
      a.weight += ((target[k] ?? 0) - a.weight) * Math.min(1, dt * 8);
      if (k === 'walk' && moving) a.timeScale = THREE.MathUtils.clamp(speed / 1.6, 0.6, 2.2);
      if (k === 'run' && moving) a.timeScale = THREE.MathUtils.clamp(speed / 6, 0.7, 1.6);
    }
    this.mixer.update(dt);
    this.emoteT += dt;
    const emoting = this.emote && !moving;
    this.emoteW += ((emoting ? 1 : 0) - this.emoteW) * Math.min(1, dt * 6);
    const riding = mode === 'ride';
    const sitting = mode === 'sit' || mode === 'drive' || riding || (this.emote === 'sit' && !moving);
    this.sitW += ((sitting ? 1 : 0) - this.sitW) * Math.min(1, dt * 6);
    this.driveW += ((mode === 'drive' || riding ? 1 : 0) - this.driveW) * Math.min(1, dt * 6);
    this.riding = riding;
    // pedal cadence follows the bicycle's speed (passed in as `speed` by the vehicle system)
    if (riding) this.pedal = (this.pedal || 0) + dt * Math.min(9, this.rideSpeed || 0) * 1.6;
    this.model.position.y = -0.48 * this.sitW;
    if (this.emoteW > 0.01 || this.sitW > 0.01) this.pose(this.emoteW, this.sitW, this.driveW);
    // swimming: lean forward
    this.model.rotation.x = mode === 'swim' ? 0.9 : mode === 'fly' && moving ? 0.5 : 0;
    this.placeAccessories();
  }

  pose(w, sw, dw = 0) {
    const B = this.bones, t = this.emoteT;
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, this.heading);
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const e = this.emote;
    if (sw > 0.01) {
      // thighs forward, shins down
      for (const s of ['Left', 'Right']) {
        aim(B[s + 'UpLeg'], B[s + 'Leg'], fwd.clone().addScaledVector(UP, -0.05).addScaledVector(right, s === 'Left' ? -0.08 : 0.08), sw);
        aim(B[s + 'Leg'], B[s + 'Foot'], UP.clone().negate().addScaledVector(fwd, 0.15), sw);
      }
    }
    if (dw > 0.01 && this.riding) {
      // on a bicycle: thighs angled down to the pedals, the two legs half a turn apart
      for (const [s, ph] of [['Left', 0], ['Right', Math.PI]]) {
        const a = (this.pedal || 0) + ph;
        aim(B[s + 'UpLeg'], B[s + 'Leg'], fwd.clone().multiplyScalar(0.75 + Math.sin(a) * 0.25).addScaledVector(UP, -0.75 + Math.cos(a) * 0.2).addScaledVector(right, s === 'Left' ? -0.06 : 0.06), dw);
        aim(B[s + 'Leg'], B[s + 'Foot'], UP.clone().negate().addScaledVector(fwd, 0.1 + Math.sin(a) * 0.25), dw);
      }
    }
    if (dw > 0.01) {
      // hands forward on the wheel / handlebars
      for (const s of ['Left', 'Right']) {
        const side = right.clone().multiplyScalar(s === 'Left' ? -0.25 : 0.25);
        aim(B[s + 'Arm'], B[s + 'ForeArm'], fwd.clone().addScaledVector(UP, -0.45).add(side), dw);
        aim(B[s + 'ForeArm'], B[s + 'Hand'], fwd.clone().addScaledVector(UP, -0.1), dw);
      }
      return;
    }
    if (e === 'wave') {
      aim(B.RightArm, B.RightForeArm, right.clone().multiplyScalar(0.6).add(UP).addScaledVector(fwd, 0.2), w);
      aim(B.RightForeArm, B.RightHand, UP.clone().addScaledVector(right, Math.sin(t * 9) * 0.45), w);
    } else if (e === 'cheer') {
      const k = 0.15 * Math.sin(t * 8);
      aim(B.RightArm, B.RightForeArm, UP.clone().addScaledVector(right, 0.35 + k), w);
      aim(B.LeftArm, B.LeftForeArm, UP.clone().addScaledVector(right, -0.35 - k), w);
      aim(B.RightForeArm, B.RightHand, UP, w); aim(B.LeftForeArm, B.LeftHand, UP, w);
      this.model.position.y += Math.abs(Math.sin(t * 8)) * 0.08 * w;
    } else if (e === 'point') {
      aim(B.RightArm, B.RightForeArm, fwd.clone().addScaledVector(UP, 0.15), w);
      aim(B.RightForeArm, B.RightHand, fwd.clone().addScaledVector(UP, 0.15), w);
    } else if (e === 'clap') {
      const open = 0.25 + Math.max(0, Math.sin(t * 11)) * 0.35;
      aim(B.RightArm, B.RightForeArm, fwd.clone().addScaledVector(UP, -0.6).addScaledVector(right, 0.35), w);
      aim(B.LeftArm, B.LeftForeArm, fwd.clone().addScaledVector(UP, -0.6).addScaledVector(right, -0.35), w);
      aim(B.RightForeArm, B.RightHand, fwd.clone().addScaledVector(UP, 0.5).addScaledVector(right, -0.55 + open), w);
      aim(B.LeftForeArm, B.LeftHand, fwd.clone().addScaledVector(UP, 0.5).addScaledVector(right, 0.55 - open), w);
    } else if (e === 'dance') {
      const s = Math.sin(t * 6), c = Math.cos(t * 3);
      aim(B.RightArm, B.RightForeArm, UP.clone().multiplyScalar(0.4 + s * 0.6).addScaledVector(right, 0.8), w);
      aim(B.LeftArm, B.LeftForeArm, UP.clone().multiplyScalar(0.4 - s * 0.6).addScaledVector(right, -0.8), w);
      aim(B.RightForeArm, B.RightHand, UP.clone().addScaledVector(fwd, 0.6 * c), w);
      aim(B.LeftForeArm, B.LeftHand, UP.clone().addScaledVector(fwd, -0.6 * c), w);
      this.model.position.y += Math.abs(Math.sin(t * 6)) * 0.07 * w;
      this.model.rotation.z = Math.sin(t * 3) * 0.12 * w;
    }
    if (e !== 'dance') this.model.rotation.z *= 0.9;
  }

  dispose() {
    this.disposed = true;
    this.group.remove(this.label);
    this.tag.remove();
    this.scene.remove(this.group);
  }
}
