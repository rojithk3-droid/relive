// The starter town at the spawn point: a plaza with a working fountain, four roads, street lamps,
// benches, flower beds, a café, two show homes you can walk into, a visitor centre, a welcome arch,
// signposts, a notice board, and the people who live here. It is generated identically on every
// client (nothing is sent over the network) and nobody can edit it.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { TOWN } from './config.js';
import { generateHouse } from './houses.js';
import { textTexture, buildMaterial } from './assets.js';
import { Avatar } from './avatar.js';

const C = TOWN;
let seq = 0;
const tid = () => 'town:' + seq++;

// the residents: where they walk (looping polylines, metres), how fast, and what they say
const RESIDENTS = [
  { name: 'Mira', role: 'guide', body: 'xbot', color: '#46c2b4', at: [3.4, 48], face: Math.PI, guide: true,
    lines: ['Welcome to ReLive! I can show you around or find you a home.', 'Everything here was built by people like you.', 'Press E near benches to sit, or near doors to open them.'] },
  { name: 'Arun', role: 'resident', body: 'soldier', color: '#d98b4a', path: [[-11, 29], [11, 29], [11, 51], [-11, 51]], speed: 1.25,
    lines: ['Lovely fountain, isn\'t it?', 'I\'m saving up for a lakeside cottage.', 'Have you seen the horses up in the eastern hills?'] },
  { name: 'Lena', role: 'resident', body: 'xbot', color: '#c86ad6', path: [[-6.5, 2], [-6.5, 30], [-4.4, 34], [-4.4, 46], [-6.5, 50], [-6.5, 80]], pingpong: true, speed: 1.4,
    lines: ['Off to the market!', 'The mountains are gorgeous at sunset.', 'Try planting sunflowers - they grow in minutes.'] },
  { name: 'Kofi', role: 'resident', body: 'soldier', color: '#4a90e2', path: [[-44, 45.2], [-13, 45.2]], pingpong: true, speed: 1.3,
    lines: ['Good to see new faces.', 'Rain\'s coming, I can feel it.', 'The café makes the best coffee on the island.'] },
  { name: 'Tom', role: 'resident', body: 'soldier', color: '#8d8d8d', sitOn: 'bench0',
    lines: ['When I was young this was all grass.', 'Sit down, rest your legs.', 'Listen... you can hear the sea from here.'] },
  { name: 'Priya', role: 'barista', body: 'xbot', color: '#f0ad4e', at: [14.7, 46.4], face: Math.PI / 2,
    lines: ['Coffee? It\'s on the house.', 'Grab a seat outside, the view is nice.', 'We open early and close late.'] },
];

export class Town {
  constructor(game) {
    this.g = game;
    this.recs = [];
    this.people = [];
    this.labels = [];
    this.interactables = [];   // { kind, pos, label, ... } for the E key
    this.fountains = [];
  }

  build() {
    const g = this.g, t = g.terrain;
    const h0 = t.heightAt(C.x, C.z);
    // flatten the town ground (local only - every client does the same)
    t.applyOp({ k: 'level', x: C.x, z: C.z, r: 40, s: 1, y: h0 });
    for (const [x, z] of [[-22, 52], [22, 52], [-22, 24], [22, 24], [0, 64], [0, 14]]) t.applyOp({ k: 'level', x, z, r: 16, s: 1, y: h0 });
    // keep the forest out of town
    for (const tr of g.trees.near(C.x, C.z, C.r + 4)) if (/^n\d+$/.test(tr.id)) g.trees.setHidden(tr.id, true);

    const put = (t, x, z, extra = {}) => this.recs.push({ id: tid(), owner: 'town', t, x, z, y: extra.y ?? g.terrain.heightAt(x, z), ry: 0, ...extra });
    // plaza
    for (let x = -10; x <= 10; x += 4) for (let z = 30; z <= 50; z += 4) put('plaza', x, z, { m: 'patterned', y: h0 });
    put('fountain', C.x, C.z, { m: 'sandstone', y: h0 + 0.15 });
    this.fountains.push(new THREE.Vector3(C.x, h0 + 0.15, C.z));
    // roads
    for (const z of [24, 16, 8, 0]) put('road', 0, z);
    for (const z of [56, 64, 72, 80]) put('road', 0, z);
    for (const x of [16, 24, 32, 40]) put('road', x, 40, { ry: Math.PI / 2 });
    for (const x of [-16, -24, -32, -40]) put('road', x, 40, { ry: Math.PI / 2 });
    // lamps: plaza corners and along the roads
    for (const [x, z] of [[-12, 28], [12, 28], [-12, 52], [12, 52], [5, 20], [-5, 4], [5, 60], [-5, 76], [24, 35], [40, 45], [-24, 45], [-40, 35]]) put('lamp_post', x, z, { m: 'metal' });
    // benches facing the fountain, flowers between them, trees in the plaza corners
    [[6.6, 40], [-6.6, 40], [0, 33.4], [0, 46.6]].forEach(([x, z], i) => {
      // turn the bench's front (its local -z, see modelFront) toward the fountain
      const ry = Math.atan2(C.x - x, C.z - z) + Math.PI;
      put('m:painted_wooden_bench', x, z, { ry, y: h0 + 0.15, id: i === 0 ? 'town:bench0' : tid() });
    });
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; put('crop:flowers', C.x + Math.cos(a) * 4.6, C.z + Math.sin(a) * 4.6, { pt: 0, y: h0 + 0.15, ry: a }); }
    for (const [x, z, sp] of [[-9, 31, 'oak'], [9, 31, 'maple'], [-9, 49, 'maple'], [9, 49, 'oak']]) put('tree:' + sp, x, z, { y: h0 + 0.1, sd: (x > 0 ? 1 : 2), s: [0.8, 0.8, 0.8] });
    // buildings
    const house = (style, floors, x0, x1, z0, z1, front, extra = {}) => {
      const baseY = t.averageHeight(x0, z0, x1, z1);
      for (const r of generateHouse({ x0, x1, z0, z1, front, floors, style, baseY, furnish: true, ...extra })) this.recs.push({ ...r, id: tid(), owner: 'town' });
      return baseY;
    };
    house('cottage', 2, -28, -16, 48, 56, 2);
    const cafeY = house('modern', 1, 16, 28, 48, 56, 2, { roof: 'flat' });
    house('villa', 2, -28, -16, 20, 28, 0, { roof: 'hip' });
    house('office', 1, 16, 28, 20, 28, 0);
    put('m:outdoor_table_chair_set_01', 19.5, 46.4, { y: h0 });
    put('m:outdoor_table_chair_set_01', 24.5, 46.4, { y: h0 });
    put('m:CoffeeCart_01', 13.4, 47.2, { y: h0, ry: Math.PI / 2 });
    put('m:potted_plant_04', 15.2, 47.6, { y: cafeY + 0.6, s: [2.4, 2.4, 2.4] });
    // vehicles anyone can borrow: two cars side by side nosed toward the east road (heading 180° = facing
    // +z), and a bike rack by the arch (heading -90° = facing east)
    put('v:car', 29, 31.4, { y: h0, ry: Math.PI });
    put('v:car', 32.6, 31.4, { y: h0, ry: Math.PI, c: '#f2c200' });
    ['#2b7bd6', '#d6452b', '#2bb673'].forEach((c, i) => put('v:bike', -9.4, 62.2 + i * 0.9, { y: h0, ry: -Math.PI / 2, c }));
    // a boat dock on the nearest coast due east of town, reached by road or bike
    let shore = null;
    for (let x = 50; x < 480; x += 1) { if (t.heightAt(x, C.z) < 0.25) { shore = x; break; } }
    if (shore) {
      for (let i = 0; i < 4; i++) put('deck', shore - 2 + i * 4, C.z, { y: 0.5, m: 'weathered' });
      put('lamp_post', shore + 13.6, C.z + 1.6, { y: 0.7, m: 'metal' });
      let bx = shore + 15;
      while (bx < shore + 40 && t.heightAt(bx, C.z) > -1) bx += 1;
      put('v:boat', bx, C.z - 3.4, { y: 0, ry: -Math.PI / 2 });
      put('v:boat', bx, C.z + 3.4, { y: 0, ry: -Math.PI / 2, c: '#a8322a' });
      this.dock = { x: shore + 4, z: C.z };
    }
    // the welcome arch over the south road: two stone pillars and a lintel (solid, like any build)
    for (const x of [-5.4, 5.4]) put('pillar', x, 60, { m: 'sandstone', y: h0, s: [2.2, 1.67, 2.2] });
    put('beam', 0, 60, { m: 'sandstone', y: h0 + 4.9, s: [2.9, 2, 3] });

    for (const r of this.recs) g.objects.set(r);

    // one-off pieces: arch sign, signposts, notice board, fountain spray, place names
    this.board(6.4, 1.3, textTexture(['Welcome to ReLive'], { w: 1024, h: 208, size: 96, bg: '#2f4a3c', fg: '#f6efd8' }), 0, h0 + 4.1, 60.5, 0);
    this.buildSignpost(-8.5, 55, h0);
    this.buildNoticeBoard(7.2, 56, h0);
    this.buildSpray(h0);
    this.placeLabel('Town Square', 0, h0 + 3.4, 40);
    this.placeLabel('Café', 22, cafeY + 4.6, 48);
    this.placeLabel('Show home', -22, h0 + 8.4, 48);
    this.placeLabel('Show home', -22, h0 + 8.4, 28);
    this.placeLabel('Visitor Centre', 22, h0 + 5, 28);
    this.placeLabel('Car park', 30.8, h0 + 2.6, 31.4);
    this.placeLabel('Bike hire', -9.4, h0 + 2, 63.1);
    if (this.dock) this.placeLabel('Boat dock', this.dock.x, 3.2, this.dock.z);
    this.h0 = h0;
    this.spawnPeople();
  }

  // ---------------------------------------------------------------- one-off meshes
  board(w, h, tex, x, y, z, ry, back = true) {
    const grp = new THREE.Group();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    face.position.z = 0.031;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, h + 0.06, 0.06), buildMaterial('wooddark'));
    grp.add(face, slab);
    if (back) { const b = face.clone(); b.rotation.y = Math.PI; b.position.z = -0.031; grp.add(b); }
    grp.position.set(x, y, z); grp.rotation.y = ry;
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.g.scene.add(grp);
    return grp;
  }

  buildSignpost(x, z, h0) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3, 8), buildMaterial('wooddark'));
    post.position.set(x, h0 + 1.5, z); post.castShadow = true;
    this.g.scene.add(post);
    // arrows point along world directions: north is -z
    const signs = [['Mountains', -Math.PI / 2, 2.6], ['Beach & sea', 0, 2.2], ['Lake', Math.PI * 0.75, 1.8], ['Forest', Math.PI, 1.4]];
    for (const [label, ang, y] of signs) {
      const tex = textTexture([label + '  ›'], { w: 512, h: 112, size: 56, bg: '#6b4a2e' });
      const b = this.board(1.6, 0.36, tex, 0, 0, 0, 0);
      // a board pointing in direction `ang` (0 = east/+x): offset its centre out along that way
      b.position.set(x + Math.cos(ang) * 0.8, h0 + y, z + Math.sin(ang) * 0.8);
      b.rotation.y = -ang;
    }
  }

  buildNoticeBoard(x, z, h0) {
    this.noticeTex = textTexture(['Notice board', { t: 'Walk up and press E', size: 30, bold: false }], { w: 512, h: 384, size: 52, bg: '#3b2a1c' });
    for (const px of [-0.9, 0.9]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.12), buildMaterial('wooddark'));
      leg.position.set(x + px, h0 + 1.2, z); leg.castShadow = true;
      this.g.scene.add(leg);
    }
    this.noticeBoard = this.board(1.9, 1.4, this.noticeTex, x, h0 + 1.65, z, 0, false);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.08, 0.5), buildMaterial('roofslate'));
    roof.position.set(x, h0 + 2.45, z); roof.rotation.x = -0.2;
    this.g.scene.add(roof);
    this.interactables.push({ kind: 'board', pos: new THREE.Vector3(x, h0, z + 0.6), label: 'Read the notice board' });
  }

  // refresh the board's face with the newest notes
  setNotes(notes) {
    const lines = [{ t: 'Notice board', size: 40 }];
    for (const n of notes.slice(-5).reverse()) lines.push({ t: `${n.n}: ${n.text}`.slice(0, 34), size: 24, bold: false });
    if (!notes.length) lines.push({ t: 'Be the first to post!', size: 26, bold: false });
    const tex = textTexture(lines, { w: 512, h: 384, size: 28, lh: 44, bg: '#3b2a1c', align: 'left' });
    this.noticeBoard.children[0].material.map = tex;
    this.noticeBoard.children[0].material.needsUpdate = true;
  }

  // water spraying from the top bowl and falling into the basin
  buildSpray(h0) {
    const n = 600, pos = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) seed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.sprayU = { uTime: { value: 0 }, uBase: { value: new THREE.Vector3(C.x, h0 + 2.2, C.z) }, uLight: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.sprayU, transparent: true, depthWrite: false,
      vertexShader: `attribute float seed; uniform float uTime; uniform vec3 uBase; varying float vA;
        void main() {
          float life = fract(uTime * 0.55 + seed * 7.3);
          float a = seed * 6.2831 * 13.0;
          vec3 v = vec3(cos(a) * 0.9, 2.6 + fract(seed * 31.0) * 0.6, sin(a) * 0.9);
          float tt = life * 1.1;
          vec3 p = uBase + v * tt + vec3(0.0, -4.9 * tt * tt, 0.0);
          p.y = max(p.y, uBase.y - 1.75);
          vA = 1.0 - life;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(90.0 / -mv.z, 1.0, 6.0);
        }`,
      fragmentShader: `uniform float uLight; varying float vA; void main() { vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(vec3(0.82, 0.9, 1.0) * uLight, 0.55 * vA); }`,
    });
    this.spray = new THREE.Points(geo, mat);
    this.spray.frustumCulled = false;
    this.g.scene.add(this.spray);
  }

  placeLabel(text, x, y, z) {
    const el = document.createElement('div');
    el.className = 'place-label';
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.set(x, y, z);
    this.g.scene.add(o);
    this.labels.push(o);
  }

  // ---------------------------------------------------------------- residents
  spawnPeople() {
    for (const def of RESIDENTS) {
      const av = new Avatar(this.g.scene, { name: def.name, body: def.body, color: def.color }, { noShadow: true });
      av.tag.classList.add('npc');
      av.tag.querySelector('.nm').textContent = `${def.name} · ${def.role}`;
      const p = { def, av, pos: new THREE.Vector3(), heading: def.face || 0, speed: 0, mode: 'walk' };
      if (def.at) p.pos.set(def.at[0], 0, def.at[1]);
      if (def.sitOn) {
        const b = this.g.objects.get('town:' + def.sitOn);
        // sit on the bench's left seat, facing out
        const ry = b.ry, side = new THREE.Vector3(0.45, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
        p.pos.set(b.x - side.x, b.y + 0.45 - 0.47, b.z - side.z);
        p.heading = ry; // the bench faces its local -z, which is where an avatar with heading = ry looks
        p.mode = 'sit';
        p.fixedY = true;
      }
      if (def.path) {
        // precompute segment lengths for walking along the loop
        const pts = def.path.map(([x, z]) => new THREE.Vector2(x, z));
        if (def.pingpong) for (let i = pts.length - 2; i > 0; i--) pts.push(pts[i].clone());
        const segs = [];
        let total = 0;
        for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const l = a.distanceTo(b); segs.push({ a, b, l }); total += l; }
        p.walk = { segs, total };
      }
      this.people.push(p);
      this.interactables.push({ kind: 'npc', person: p, pos: p.pos, label: `Talk to ${def.name}` });
    }
  }

  update(dt) {
    const g = this.g, t = g.now() / 1000;
    for (const p of this.people) {
      if (p.walk) {
        // position along the loop is a function of the shared clock, so everyone sees them in the same spot
        let d = (t * p.def.speed + p.def.name.length * 7) % p.walk.total;
        for (const s of p.walk.segs) {
          if (d <= s.l) {
            const f = d / s.l;
            p.pos.set(s.a.x + (s.b.x - s.a.x) * f, 0, s.a.y + (s.b.y - s.a.y) * f);
            p.heading = Math.atan2(-(s.b.x - s.a.x), -(s.b.y - s.a.y));
            break;
          }
          d -= s.l;
        }
        p.speed = p.def.speed;
      }
      if (!p.fixedY) p.pos.y = g.player.groundAt(p.pos.x, p.pos.z, g.terrain.heightAt(p.pos.x, p.pos.z) + 0.5, 0);
      // stop and turn toward a player who comes to chat
      const me = g.player.pos;
      if (p.talkUntil && p.talkUntil > performance.now()) { p.speed = 0; p.heading = Math.atan2(-(me.x - p.pos.x), -(me.z - p.pos.z)); }
      const reach = g.q?.people || 110;
      const far = p.pos.distanceToSquared(g.camera.position) > reach * reach;
      p.av.group.visible = !far;
      if (!far) p.av.update(dt, p.pos, p.heading, p.speed, p.mode);
    }
    if (this.sprayU) { this.sprayU.uTime.value += dt; this.sprayU.uLight.value = 0.25 + g.env.daylight * 0.75; }
    for (const l of this.labels) l.visible = l.position.distanceToSquared(g.camera.position) < 90 * 90;
  }

  talk(p) {
    const lines = [...p.def.lines];
    const w = this.g.weather;
    if (w && w.rain > 0.3) lines.push('Bit wet today! The café is dry.');
    if (this.g.env.daylight < 0.3) lines.push('Beautiful night. Look at the stars!');
    const line = lines[Math.floor(Math.random() * lines.length)];
    p.av.say(line);
    p.talkUntil = performance.now() + 6000;
    return line;
  }

  fountainNear(cam) {
    let best = 0;
    for (const f of this.fountains) best = Math.max(best, 1 - Math.min(1, f.distanceTo(cam) / 28));
    return best;
  }
}
