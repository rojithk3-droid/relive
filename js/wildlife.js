// Animals: parrot flocks wheeling over the forests, storks gliding along the coast, flamingos over the
// lake and wild horse herds galloping across the eastern hills. Every animal's position is a function
// of the shared server clock, so all players see the same flock in the same place.
import * as THREE from 'three';
import { loadAnimal } from './assets.js';
import { HALF, SEA } from './config.js';
import { rng } from './noise.js';

const UP = new THREE.Vector3(0, 1, 0);
const SPECIES = {
  parrot:   { file: 'Parrot.glb',   size: 0.6, fly: true },
  stork:    { file: 'Stork.glb',    size: 1.8, fly: true },
  flamingo: { file: 'Flamingo.glb', size: 1.5, fly: true },
  horse:    { file: 'Horse.glb',    size: 2.4, fly: false },
};

export class Wildlife {
  constructor(game) {
    this.g = game;
    this.groups = [];
    this.animals = [];
  }

  // choose habitats from the terrain (deterministic) and spawn everyone
  spawn() {
    const t = this.g.terrain, r = rng(911);
    const land = (x, z) => Math.abs(x) < HALF - 20 && Math.abs(z) < HALF - 20 && t.heightAt(x, z) > 2;
    // parrots: over forest patches
    let made = 0;
    for (let i = 0; i < 400 && made < 5; i++) {
      const x = (r() * 2 - 1) * 380, z = (r() * 2 - 1) * 380;
      if (!land(x, z) || t.forestMask(x, z) < 0.6 || Math.hypot(x, z - 40) < 120) continue;
      this.addFlock('parrot', { cx: x, cz: z, R: 35 + r() * 35, alt: 18 + r() * 14, speed: 9, n: 6, seed: i });
      made++;
    }
    // storks: long loops around the coast
    this.addFlock('stork', { cx: 0, cz: 0, R: 400, alt: 32, speed: 11, n: 5, seed: 1, ellipse: 0.9 });
    this.addFlock('stork', { cx: 30, cz: -20, R: 330, alt: 45, speed: 10, n: 4, seed: 2, dir: -1, ellipse: 1.1 });
    // flamingos: low over the lake
    this.addFlock('flamingo', { cx: -210, cz: 170, R: 45, alt: 5, speed: 8, n: 7, seed: 3, ellipse: 0.75 });
    // horses: find two gentle rings of open land in the east
    made = 0;
    for (let i = 0; i < 600 && made < 2; i++) {
      const cx = 120 + r() * 300, cz = -200 + r() * 360, R = 40 + r() * 25;
      let ok = true;
      for (let k = 0; k < 24 && ok; k++) {
        const a = (k / 24) * Math.PI * 2, x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R * 0.7;
        if (!land(x, z) || t.heightAt(x, z) > 60 || t.normalAt(x, z).y < 0.88) ok = false;
      }
      if (!ok) continue;
      this.addFlock('horse', { cx, cz, R, alt: 0, speed: 7.5, n: 4, seed: 10 + i, ellipse: 0.7, ground: true });
      made++;
    }
  }

  addFlock(kind, o) {
    const grp = { kind, ...o, members: [] };
    const r = rng(o.seed * 97 + 13);
    for (let i = 0; i < o.n; i++) {
      // a loose formation: behind and to the side of the leader, with its own bob
      grp.members.push({ back: i === 0 ? 0 : (2 + r() * 3) * (o.ground ? 1.4 : 1) * Math.ceil(i / 2), side: i === 0 ? 0 : (i % 2 ? 1 : -1) * (1.5 + r() * 2.5), up: o.ground ? 0 : (r() - 0.5) * 3, phase: r() * 10, obj: null, mixer: null });
    }
    this.groups.push(grp);
    loadAnimal(SPECIES[kind].file).then((gltf) => {
      if (!gltf) return;
      // normalise: longest horizontal side = the species size; find which way the body points
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const sz = box.getSize(new THREE.Vector3());
      const scale = SPECIES[kind].size / Math.max(sz.x, sz.z);
      for (const m of grp.members) {
        const holder = new THREE.Group();
        const inner = gltf.scene.clone(true);
        inner.scale.setScalar(scale);
        // birds are high up and their shadows would be specks; only the horses cast shadows
        if (!o.ground) inner.traverse((x) => { if (x.isMesh) x.castShadow = false; });
        holder.add(inner);
        holder.visible = false;
        this.g.scene.add(holder);
        const mixer = new THREE.AnimationMixer(inner);
        if (gltf.animations[0]) { const a = mixer.clipAction(gltf.animations[0]); a.play(); a.time = m.phase; a.timeScale = kind === 'horse' ? 1.4 : 1; }
        m.obj = holder; m.mixer = mixer;
      }
    });
  }

  update(dt) {
    const g = this.g, t = g.now() / 1000, cam = g.camera.position;
    for (const grp of this.groups) {
      const dir = grp.dir || 1, ell = grp.ellipse || 1;
      // leader position on the loop and its direction of travel
      const ang = dir * (t * grp.speed) / grp.R + grp.seed;
      for (const m of grp.members) {
        if (!m.obj) continue;
        const a = ang - dir * m.back / grp.R;
        const px = grp.cx + Math.cos(a) * grp.R, pz = grp.cz + Math.sin(a) * grp.R * ell;
        const tx = -Math.sin(a) * dir, tz = Math.cos(a) * ell * dir;
        const tl = Math.hypot(tx, tz);
        const nx = tx / tl, nz = tz / tl;
        const x = px + -nz * m.side, z = pz + nx * m.side;
        const d2 = (x - cam.x) ** 2 + (z - cam.z) ** 2;
        const reach = (g.q?.people || 110) * 2.2;   // ~150 m on low, ~350 m on high
        const visible = d2 < reach * reach;
        m.obj.visible = visible;
        if (!visible) continue;
        let y;
        if (grp.ground) y = g.terrain.heightAt(x, z);
        else y = Math.max(g.terrain.heightAt(x, z), SEA) + grp.alt + m.up + Math.sin(t * 0.8 + m.phase) * 1.2;
        m.obj.position.set(x, y, z);
        // the three.js models face +z; turn them to the direction of travel and bank into the turn
        m.obj.rotation.set(0, Math.atan2(nx, nz), 0);
        if (!grp.ground) m.obj.rotateZ(-dir * 0.25);
        if (d2 < 260 * 260) m.mixer.update(dt);
      }
    }
  }
}
