// A person in the world: rigged body, walk/run blending, a floating name tag with speech bubbles, and
// procedural emotes (wave, cheer, point, clap, dance, sit) posed by aiming bones in world space, so they
// work on any Mixamo-style skeleton without extra animation files.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadBody, BODIES } from './assets.js';

const UP = new THREE.Vector3(0, 1, 0);
const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3();

function findBone(root, suffix) {
  let hit = null;
  root.traverse((o) => { if (!hit && o.isBone && o.name.replace(/[^A-Za-z]/g, '').endsWith(suffix)) hit = o; });
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

export class Avatar {
  constructor(scene, profile) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    scene.add(this.group);
    this.anim = 'idle';
    this.emote = null;
    this.emoteT = 0;
    this.emoteW = 0;
    this.sitW = 0;
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
    const kind = BODIES[p.body] ? p.body : 'soldier';
    if (this.kind === kind && this.model) { this.applyTint(); return; }
    this.kind = kind;
    const src = await loadBody(kind);
    if (!src || this.disposed || this.kind !== kind) return;
    if (this.model) this.group.remove(this.model);
    this.model = SkeletonUtils.clone(src.scene);
    this.model.rotation.y = src.def.yaw;
    this.model.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.userData.baseColor = o.material.color.clone(); } });
    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const [k, name] of Object.entries(src.def.clips)) {
      const clip = src.animations.find((c) => c.name === name);
      if (clip) { const a = this.mixer.clipAction(clip); a.play(); a.weight = k === 'idle' ? 1 : 0; this.actions[k] = a; }
    }
    this.bones = {};
    for (const n of ['Hips', 'Spine', 'Spine2', 'Head', 'RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftUpLeg', 'LeftLeg', 'LeftFoot']) this.bones[n] = findBone(this.model, n);
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
    const sitting = mode === 'sit' || (this.emote === 'sit' && !moving);
    this.sitW += ((sitting ? 1 : 0) - this.sitW) * Math.min(1, dt * 6);
    this.model.position.y = -0.48 * this.sitW;
    if (this.emoteW > 0.01 || this.sitW > 0.01) this.pose(this.emoteW, this.sitW);
    // swimming: lean forward
    this.model.rotation.x = mode === 'swim' ? 0.9 : mode === 'fly' && moving ? 0.5 : 0;
  }

  pose(w, sw) {
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
