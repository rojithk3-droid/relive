// Shared weather. The forecast is a pure function of the server clock (12-minute spells picked from
// the seed), so every player sees the same rain at the same moment with no network traffic. Drives the
// clouds, light, fog, wet ground, wind in the trees, rain/snow particles, lightning and thunder.
import * as THREE from 'three';
import { hash2 } from './noise.js';
import { wind as treeWind } from './trees.js';

const SPELL_MS = 12 * 60 * 1000;
export const KINDS = {
  clear:  { cover: 0.5,  gloom: 0,    fog: 0,    rain: 0,   wind: 0.2,  storm: 0, label: 'Clear' },
  cloudy: { cover: 0.3,  gloom: 0.3,  fog: 0.15, rain: 0,   wind: 0.4,  storm: 0, label: 'Cloudy' },
  rain:   { cover: 0.12, gloom: 0.6,  fog: 0.35, rain: 0.7, wind: 0.55, storm: 0, label: 'Rain' },
  storm:  { cover: 0.04, gloom: 0.82, fog: 0.5,  rain: 1,   wind: 1,    storm: 1, label: 'Thunderstorm' },
  fog:    { cover: 0.35, gloom: 0.35, fog: 1,    rain: 0,   wind: 0.05, storm: 0, label: 'Fog' },
};
const ORDER = ['clear', 'cloudy', 'rain', 'storm', 'fog'];

function spellKind(n) {
  const r = hash2(n, 17, 4242);
  return r < 0.5 ? 'clear' : r < 0.7 ? 'cloudy' : r < 0.85 ? 'rain' : r < 0.92 ? 'storm' : 'fog';
}

export class Weather {
  constructor(game) {
    this.g = game;
    const k = KINDS.clear;
    Object.assign(this, { cover: k.cover, gloom: 0, fog: 0, rain: 0, wind: 0.2, storm: 0 });
    this.kind = 'clear';
    this.flash = 0;
    this.nextBolt = 6;
    this.indoors = false;
    this.buildRain(game.q?.grass > 60000 ? 7000 : 3500);
  }

  // the forecast at time t: the current spell, blended into from the previous one over 90 s
  target(t) {
    const forced = this.g.settings.weather;
    if (forced && KINDS[forced]) return { ...KINDS[forced], kind: forced };
    const n = Math.floor(t / SPELL_MS), into = (t - n * SPELL_MS) / 90000;
    const cur = KINDS[spellKind(n)], prev = KINDS[spellKind(n - 1)];
    const f = Math.min(1, into);
    const out = { kind: spellKind(n) };
    for (const key of ['cover', 'gloom', 'fog', 'rain', 'wind', 'storm']) out[key] = prev[key] + (cur[key] - prev[key]) * f;
    return out;
  }

  // what the sky will do next (for the HUD)
  forecast(t) {
    const n = Math.floor(t / SPELL_MS);
    return { now: spellKind(n), next: spellKind(n + 1), minutes: Math.ceil(((n + 1) * SPELL_MS - t) / 60000) };
  }

  buildRain(count) {
    // each drop is a short streak; the vertex shader wraps it in a box that follows the camera
    const pos = new Float32Array(count * 2 * 3), seed = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random(), s = Math.random();
      pos.set([x, y, z, x, y, z], i * 6);
      seed[i * 2] = s; seed[i * 2 + 1] = s + 10; // second vertex is the streak's tail
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.rainUniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAmount: { value: 0 }, uSnow: { value: 0 }, uWind: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(0.75, 0.8, 0.88) } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.rainUniforms, transparent: true, depthWrite: false,
      vertexShader: `
        attribute float seed; uniform float uTime, uAmount, uSnow; uniform vec3 uCam; uniform vec2 uWind;
        varying float vA;
        void main() {
          float tail = step(5.0, seed); float s = seed - tail * 10.0;
          vec3 box = vec3(46.0, 32.0, 46.0);
          float speed = mix(17.0, 1.6, uSnow);
          vec3 p = position * box;
          p.y -= uTime * speed * (0.8 + s * 0.4);
          p.xz += uWind * uTime * mix(0.35, 1.0, uSnow) + vec2(sin(uTime * 0.7 + s * 20.0), cos(uTime * 0.6 + s * 17.0)) * uSnow * 0.6;
          // wrap around the camera
          p = mod(p - uCam + box * 0.5, box) - box * 0.5 + uCam;
          vec3 dir = normalize(vec3(uWind.x * 0.05, -1.0, uWind.y * 0.05));
          p -= dir * tail * mix(1.1, 0.05, uSnow);
          vA = step(s, uAmount) * (1.0 - smoothstep(14.0, 23.0, length(p.xz - uCam.xz)));
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          gl_PointSize = 3.0;
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uSnow; varying float vA; void main() { if (vA < 0.01) discard; gl_FragColor = vec4(mix(uColor, vec3(1.0), uSnow), vA * mix(0.6, 0.9, uSnow)); }`,
    });
    this.rainMesh = new THREE.LineSegments(geo, mat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 5;
    this.g.scene.add(this.rainMesh);
  }

  update(dt) {
    const g = this.g;
    const tgt = this.target(g.now());
    this.kind = tgt.kind;
    const k = 1 - Math.exp(-dt * 0.5);
    for (const key of ['cover', 'gloom', 'fog', 'rain', 'wind', 'storm']) this[key] += (tgt[key] - this[key]) * k;

    // under a roof? (a solid surface overhead within 8 m) - rain stops falling around you
    this.roofTimer = (this.roofTimer || 0) - dt;
    if (this.roofTimer <= 0) {
      this.roofTimer = 0.4;
      const cam = g.camera.position;
      const hit = g.objects.pick(new THREE.Ray(cam.clone(), new THREE.Vector3(0, 1, 0)), 8);
      this.indoors = !!hit;
    }

    // lightning: a bright flash, then thunder after the sound has travelled
    this.flash = Math.max(0, this.flash - dt * 4);
    if (this.storm > 0.6) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 7 + Math.random() * 18;
        this.flash = 1;
        const dist = 0.4 + Math.random() * 3;
        if (g.sound) g.sound.thunder(0.7 + Math.random() * 0.5, dist);
      }
    }

    // rain / snow particles
    const u = this.rainUniforms, cam = g.camera.position;
    u.uTime.value += dt;
    u.uCam.value.copy(cam);
    const windDir = new THREE.Vector2(Math.cos(1.1), Math.sin(1.1)).multiplyScalar(2 + this.wind * 9);
    u.uWind.value.copy(windDir);
    u.uSnow.value = THREE.MathUtils.smoothstep(cam.y, 70, 90);
    u.uAmount.value = this.indoors ? 0 : this.rain;
    u.uColor.value.setScalar(0.35 + g.env.daylight * 0.45);
    this.rainMesh.visible = this.rain > 0.01;

    // hand the mood to the sky/terrain/trees
    g.env.weather = { cover: this.cover, gloom: this.gloom, fog: this.fog, flash: this.flash };
    g.terrain.uniforms.uWet.value = Math.min(1, this.rain * 1.3);
    treeWind.uWind.value = 0.6 + this.wind * 2.2;
  }
}

export { ORDER as WEATHER_ORDER };
