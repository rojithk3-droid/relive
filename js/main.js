// ReLive client entry point: sets up rendering, the world systems and the network, applies every
// message from the server, and runs the frame loop. Other modules reach shared state through `game`.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { QUALITY, DAY_MS, SPAWN, PLOT, plotKey, detectQuality } from './config.js';
import { setTextureQuality, buildMaterial } from './assets.js';
import { Terrain } from './terrain.js';
import { Environment } from './environment.js';
import { Trees } from './trees.js';
import { WorldObjects } from './objects.js';
import { Grass } from './grass.js';
import { Avatar } from './avatar.js';
import { Player } from './player.js';
import { Net } from './net.js';
import { ITEMS } from './catalog.js';
import { BuildTools } from './build.js';
import { UI } from './ui.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem('rl.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rl.' + k, JSON.stringify(v)); } catch { } },
};

class Game {
  constructor() {
    this.store = store;
    this.settings = Object.assign({ quality: 'auto', adaptive: true, time: 'world', sens: 1, invertY: false, names: true, chatBubbles: true }, store.get('settings', {}));
    // settings v2: earlier builds defaulted everyone to "high", far too heavy for laptop graphics
    if (this.settings.v !== 2) { this.settings.quality = 'auto'; this.settings.adaptive = true; this.settings.v = 2; store.set('settings', this.settings); }
    // ?as=name runs a separate identity in the same browser (handy for testing with two tabs)
    const as = new URLSearchParams(location.search).get('as');
    this.profileKey = as ? 'profile.' + as : 'profile';
    this.profile = store.get(this.profileKey, null);
    this.me = { sid: 0, uid: '' };
    this.players = new Map();         // sid -> { uid, profile, avatar, target, heading, speed, mode }
    this.users = new Map();           // uid -> latest name (for owner labels)
    this.plots = new Map();           // key -> { owner, open, name }
    this.serverOffset = 0;
    this.epoch = Date.now();
    this.ready = false;
    this.clock = new THREE.Clock();
    this.idSeq = 0;

    this.initRenderer();
    this.terrain = new Terrain(this.scene);
    this.env = new Environment(this.renderer, this.scene, this.terrain);
    this.trees = new Trees(this.scene, this.renderer, this.terrain);
    this.objects = new WorldObjects(this.scene, this.terrain, this.trees);
    this.grass = new Grass(this.scene, this.terrain, this.objects);
    this.player = new Player(this.camera, this.renderer.domElement, this.terrain, this.objects, this.trees);
    this.initLights();
    this.applyQuality();
    this.net = new Net();
    this.net.onLine = (l) => this.onLine(l);
    this.net.onStatus = (s) => this.ui && this.ui.setStatus(s);
    this.player.settings = { sens: this.settings.sens, invertY: this.settings.invertY };
    this.player.wheelBlocked = (e) => !!e.target.closest('#side, #chat, .modal, .float');
    this.player.onFreeCam = (on) => this.ui && this.ui.setFreeCam(on);
    this.build = new BuildTools(this);
    this.ui = new UI(this);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.ui.boot();
  }

  // ---------------------------------------------------------------- rendering
  initRenderer() {
    const canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 12000);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    document.getElementById('app').appendChild(this.labels.domElement);
  }

  initLights() {
    // a handful of real point lights handed to the closest lamps at night
    this.lampLights = [];
    for (let i = 0; i < 12; i++) {
      const l = new THREE.PointLight(0xffd9a0, 0, 20, 2);
      l.visible = false;
      this.scene.add(l);
      this.lampLights.push(l);
    }
    this.lampTimer = 0;
  }

  applyQuality() {
    if (!this.detected) this.detected = detectQuality(this.renderer);
    this.qualityName = this.settings.quality === 'auto' || !QUALITY[this.settings.quality] ? this.detected.q : this.settings.quality;
    const q = QUALITY[this.qualityName];
    this.q = q;
    setTextureQuality(q.texRes, Math.min(this.renderer.capabilities.getMaxAnisotropy(), q.cheapTerrain ? 4 : 8));
    this.basePixelRatio = Math.min(devicePixelRatio, q.maxDpr) * q.pixelRatio;
    this.resScale = 1;
    this.renderer.setPixelRatio(this.basePixelRatio);
    const softType = q.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.renderer.shadowMap.type !== softType) {
      this.renderer.shadowMap.type = softType;
      this.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
    }
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.env.setShadowSize(q.shadow);
    this.env.clouds.visible = q.clouds;
    this.terrain.setCheap(q.cheapTerrain);
    this.trees.nearDist = q.treeNear;
    this.trees.shadowDist = q.treeShadow;
    this.trees.lodDirty = true;
    this.grass.build(q.grass, q.grassRadius);
    this.buildComposer();
  }

  buildComposer() {
    const w = innerWidth, h = innerHeight;
    if (this.composer) this.composer.dispose();
    this.composer = null;
    this.bloom = null;
    this.fxaa = null;
    // the cheapest path: no offscreen buffers at all, tone mapping happens in each material
    if (!this.q.post) { this.resize(); return; }
    const c = new EffectComposer(this.renderer);
    c.addPass(new RenderPass(this.scene, this.camera));
    if (this.q.ao) {
      const ao = new GTAOPass(this.scene, this.camera, w, h);
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1, scale: 1 });
      ao.blendIntensity = 0.85;
      c.addPass(ao);
    }
    if (this.q.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.28, 0.5, 0.92);
      c.addPass(this.bloom);
    } else this.bloom = null;
    c.addPass(new OutputPass());
    if (this.q.aa === 'smaa') c.addPass(new SMAAPass(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio()));
    else if (this.q.aa === 'fxaa') { this.fxaa = new ShaderPass(FXAAShader); c.addPass(this.fxaa); }
    this.composer = c;
    this.resize();
  }

  // Dynamic resolution: drop the render scale when the frame rate sags, creep back up when there is room.
  adaptResolution(dt) {
    if (this.settings.adaptive === false || document.hidden || dt > 0.25) return;
    this.fpsFrames = (this.fpsFrames || 0) + 1;
    this.fpsTime = (this.fpsTime || 0) + dt;
    if (this.fpsTime < 1) return;
    const fps = this.fpsFrames / this.fpsTime;
    this.fps = fps;
    this.fpsFrames = 0; this.fpsTime = 0;
    let s = this.resScale;
    if (fps < 40 && s > 0.5) { s = Math.max(0.5, s * (fps < 25 ? 0.75 : 0.88)); this.goodSeconds = 0; }
    else if (fps > 56) { this.goodSeconds = (this.goodSeconds || 0) + 1; if (this.goodSeconds >= 3 && s < 1) { s = Math.min(1, s * 1.08); this.goodSeconds = 0; } }
    else this.goodSeconds = 0;
    if (Math.abs(s - this.resScale) > 0.01) { this.resScale = s; this.renderer.setPixelRatio(this.basePixelRatio * s); this.resize(); }
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.composer) this.composer.setSize(w, h);
    if (this.fxaa) { const pr = this.renderer.getPixelRatio(); this.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr)); }
    this.labels.setSize(w, h);
  }

  // ---------------------------------------------------------------- joining
  start(profile) {
    this.profile = profile;
    store.set(this.profileKey, profile);
    this.myAvatar = new Avatar(this.scene, profile);
    const last = store.get('pos', null);
    const p = last && Math.abs(last.x) < 700 ? last : { x: SPAWN.x, z: SPAWN.z };
    this.player.setPosition(p.x, null, p.z);
    this.player.camYaw = last?.yaw ?? 0;
    this.trees.populate();
    this.net.connect(JSON.stringify(profile));
    this.loop();
  }

  updateProfile(profile) {
    this.profile = profile;
    store.set(this.profileKey, profile);
    this.myAvatar.setProfile(profile);
    this.users.set(this.me.uid, profile.name);
    this.net.send('N ' + JSON.stringify(profile));
  }

  newId() { return (this.me.uid || 'x').slice(0, 6) + '-' + Date.now().toString(36) + '-' + (this.idSeq++).toString(36) + Math.random().toString(36).slice(2, 5); }
  now() { return Date.now() + this.serverOffset; }

  // ---------------------------------------------------------------- network in
  onLine(line) {
    const cmd = line[0], rest = line.slice(2);
    const f = (n) => { const a = rest.split('\t'); return a.length > n ? [...a.slice(0, n - 1), a.slice(n - 1).join('\t')] : a; };
    const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    switch (cmd) {
      case 'Y': {
        const [sid, uid, now, epoch] = f(4);
        this.me.sid = +sid; this.me.uid = uid;
        this.serverOffset = +now - Date.now();
        this.epoch = +epoch;
        this.users.set(uid, this.profile.name);
        break;
      }
      case 'B':
        if (rest === 'end') { this.ready = true; this.ui.onReady(); }
        else this.loadingSnapshot = true;
        break;
      case 'N': {
        const [sid, uid, json] = f(3);
        const prof = parse(json) || {};
        this.users.set(uid, prof.name || 'Guest');
        if (+sid === this.me.sid) break;
        let pl = this.players.get(+sid);
        if (!pl) {
          pl = { sid: +sid, uid, profile: prof, avatar: new Avatar(this.scene, prof), target: null, heading: 0, speed: 0, mode: 'walk', pos: new THREE.Vector3() };
          this.players.set(+sid, pl);
          if (this.ready) this.ui.system(`${prof.name || 'Someone'} joined the world`);
        } else { pl.profile = prof; pl.avatar.setProfile(prof); }
        this.ui.refreshPeople();
        break;
      }
      case 'P': {
        const [sid, json] = f(2);
        const pl = this.players.get(+sid), s = parse(json);
        if (!pl || !s) break;
        if (!pl.target) pl.pos.set(s.x, s.y, s.z);
        pl.target = new THREE.Vector3(s.x, s.y, s.z);
        pl.heading = s.h; pl.speed = s.v; pl.mode = s.m;
        if (s.e !== undefined && s.e !== pl.emote) { pl.emote = s.e; pl.avatar.setEmote(s.e); }
        break;
      }
      case 'X': {
        const pl = this.players.get(+rest);
        if (pl) { pl.avatar.dispose(); this.players.delete(+rest); this.ui.system(`${pl.profile.name || 'Someone'} left`); this.ui.refreshPeople(); }
        break;
      }
      case 'O': {
        const [id, owner, x, z, json] = f(5);
        const r = parse(json);
        if (!r) break;
        this.objects.set({ ...r, id, owner, x: +x, z: +z });
        this.build.onRemoteChange(id);
        break;
      }
      case 'D': this.objects.removeRec(rest.trim()); this.build.onRemoteChange(rest.trim()); break;
      case 'T': {
        const [x, z, r, json] = f(4);
        const op = parse(json);
        if (op) this.terrain.applyOp({ ...op, x: +x, z: +z, r: +r });
        break;
      }
      case 'L': {
        const [key, owner, open, json] = f(4);
        const meta = parse(json) || {};
        this.plots.set(key, { owner, open: open === '1', name: meta.name || '' });
        this.build.plotsChanged();
        break;
      }
      case 'R': this.plots.delete(rest.trim()); this.build.plotsChanged(); break;
      case 'C': {
        const [sid, uid, time, json] = f(4);
        const m = parse(json);
        if (!m) break;
        this.ui.chatLine({ sid: +sid, uid, time: +time, ...m }, !this.ready);
        if (this.ready && this.settings.chatBubbles && m.text && !m.text.startsWith('/')) {
          const av = +sid === this.me.sid ? this.myAvatar : this.players.get(+sid)?.avatar;
          if (av && (!m.near || this.distanceTo(+sid) < 40)) av.say(m.text);
        }
        break;
      }
      case 'W': {
        const [from, to, json] = f(3);
        const m = parse(json);
        if (m) this.ui.whisperLine(+from, +to, m);
        break;
      }
      case 'E': this.ui.toast(rest, 'warn'); break;
    }
  }

  distanceTo(sid) {
    const pl = this.players.get(sid);
    return pl ? pl.pos.distanceTo(this.player.pos) : 1e9;
  }

  // ---------------------------------------------------------------- permissions (mirrors the server)
  plotAt(x, z) { return this.plots.get(plotKey(x, z)); }
  canBuild(x, z) { const p = this.plotAt(x, z); return !p || p.owner === this.me.uid || p.open; }
  canModify(rec) {
    if (!rec) return false;
    if (rec.owner === this.me.uid) return true;
    const p = this.plotAt(rec.x, rec.z);
    return !!p && p.owner === this.me.uid;
  }
  ownerName(uid) { return uid === this.me.uid ? 'you' : this.users.get(uid) || 'a resident'; }

  // ---------------------------------------------------------------- network out
  putObject(rec) {
    const { id, owner, x, z, _pool, ...data } = rec;
    const r = (v) => Math.round(v * 1000) / 1000;
    if (data.y !== undefined) data.y = r(data.y);
    if (data.ry !== undefined) data.ry = r(data.ry);
    if (data.s && data.s.every((v) => v === 1)) delete data.s;
    const full = { id, owner: owner || this.me.uid, x: r(x), z: r(z), ...data };
    this.objects.set(full);
    this.net.send(`O ${id}\t${r(x)}\t${r(z)}\t${JSON.stringify(data)}`);
    return full;
  }
  deleteObject(id) {
    if (!this.objects.get(id)) return;
    this.objects.removeRec(id);
    this.net.send('D ' + id);
  }
  terrainOp(op) {
    const { x, z, r, ...rest } = op;
    this.terrain.applyOp(op);
    this.net.send(`T ${x.toFixed(2)}\t${z.toFixed(2)}\t${r.toFixed(2)}\t${JSON.stringify(rest)}`);
  }
  claimPlot(key, name, open) { this.net.send(`L ${key}\t${open ? 1 : 0}\t${JSON.stringify({ name })}`); }
  releasePlot(key) { this.net.send('R ' + key); }
  // the sender's name rides along so chat history still reads right after they leave
  chat(m) { this.net.send('C ' + JSON.stringify({ ...m, n: this.profile.name })); }
  whisper(sid, text) { this.net.send(`W ${sid}\t${JSON.stringify({ text })}`); }
  emote(e) {
    this.myEmote = e;
    this.myAvatar.setEmote(e);
    this.player.sitting = e === 'sit';
    this.sendState(true);
  }
  sendState(force) {
    const now = performance.now();
    if (!force && now - (this.lastSend || 0) < 100) return;
    this.lastSend = now;
    const s = this.player.snapshot();
    s.e = this.myEmote || null;
    const json = JSON.stringify(s);
    if (!force && json === this.lastState && now - this.lastSend < 2000) return;
    this.lastState = json;
    this.net.send('P ' + json);
  }

  // ---------------------------------------------------------------- frame
  timeOfDay() {
    const fixed = { morning: 0.3, noon: 0.5, sunset: 0.74, night: 0.92 }[this.settings.time];
    if (fixed !== undefined) return fixed;
    return ((this.now() - this.epoch) / DAY_MS + 0.33) % 1;
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const typing = this.ui.isTyping();
    this.player.leftDragOrbits = this.build.mode === 'explore';
    this.player.qeOrbit = !this.build.usesRotateKeys();
    this.player.update(dt, !typing);
    if (this.player.speed > 0.5 && this.myEmote) { this.myEmote = null; this.myAvatar.setEmote(null); }
    this.myAvatar.update(dt, this.player.pos, this.player.heading, this.player.speed, this.player.mode);
    this.myAvatar.group.visible = this.player.camDist >= 1;
    this.player.updateCamera(dt);
    for (const pl of this.players.values()) {
      if (pl.target) pl.pos.lerp(pl.target, Math.min(1, dt * 10));
      pl.avatar.update(dt, pl.pos, pl.heading, pl.speed, pl.mode);
    }
    if (this.ready) this.sendState();

    this.env.setTimeOfDay(this.timeOfDay());
    this.env.update(dt, this.player.pos, this.camera);
    const night = 1 - this.env.daylight;
    buildMaterial('emissive').emissiveIntensity = 0.4 + night * 2.6;
    this.updateLamps(dt, night);
    this.terrain.update();
    this.trees.update(dt, this.camera);
    this.grass.update(this.camera);
    this.build.update(dt);
    this.ui.update(dt);

    // the shadow map only re-renders every `shadowEvery` frames (static shadows don't need more)
    this.frameNo = (this.frameNo || 0) + 1;
    if (this.frameNo % this.q.shadowEvery === 0) this.renderer.shadowMap.needsUpdate = true;
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    if (this.settings.names) this.labels.render(this.scene, this.camera);
    this.adaptResolution(dt);

    this.saveTimer = (this.saveTimer || 0) + dt;
    if (this.saveTimer > 3) { this.saveTimer = 0; store.set('pos', { x: this.player.pos.x, z: this.player.pos.z, yaw: this.player.camYaw }); }
  }

  updateLamps(dt, night) {
    this.lampTimer -= dt;
    if (this.lampTimer > 0) return;
    this.lampTimer = 0.4;
    const on = night > 0.35;
    const cam = this.camera.position;
    let list = [];
    if (on) {
      for (const id of this.objects.lights) {
        const r = this.objects.get(id);
        if (!r) continue;
        const d = (r.x - cam.x) ** 2 + (r.z - cam.z) ** 2;
        if (d < 160 * 160) list.push([d, r]);
      }
      list.sort((a, b) => a[0] - b[0]);
    }
    this.lampLights.forEach((l, i) => {
      const e = list[i];
      if (!e) { l.visible = false; return; }
      const r = e[1], L = ITEMS[r.t].light;
      l.visible = true;
      l.color.set(L.color);
      l.intensity = L.intensity * Math.min(1, (night - 0.35) * 3) * (r.s?.[1] || 1);
      l.distance = L.distance;
      l.position.set(r.x, r.y + L.y * (r.s?.[1] || 1), r.z);
    });
  }

  // ---------------------------------------------------------------- helpers for tools/UI
  rayFromEvent(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(v, this.camera);
    return rc.ray;
  }
  teleport(x, z) {
    this.player.setPosition(x, null, z);
    this.player.flying = false;
    this.sendState(true);
  }
}

const game = new Game();
window.__relive = game;
export default game;
export { PLOT };
