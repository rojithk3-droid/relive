// The sound of the island, all synthesised with WebAudio (nothing to download): wind that rises with
// altitude and storms, surf near the coast, rain and thunder, birdsong by day, crickets by night, the
// town fountain, and footsteps that change with what you're walking on.
import * as THREE from 'three';
import { SEA } from './config.js';
import { ITEMS } from './catalog.js';

const WOOD = /wood|floor|parquet|laminate|weathered|bluewood|plank/;
const STONE = /stone|tile|marble|concrete|paver|cobble|asphalt|granite|terrazzo|brick|patterned/;

export class Sound {
  constructor(game) {
    this.g = game;
    this.ctx = null;
    this.stepDist = 0;
    this.birdTimer = 2;
    this.lastPos = new THREE.Vector3();
    this.envTimer = 0;
    this.near = { water: 0, trees: 0, fountain: 0 };
  }

  // browsers only allow audio after a click or key press
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try { this.ctx = new AudioContext(); } catch { return; }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.connect(c.destination);
    this.setVolume();
    // shared noise buffers
    const len = c.sampleRate * 4;
    const white = c.createBuffer(1, len, c.sampleRate), brown = c.createBuffer(1, len, c.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const r = Math.random() * 2 - 1; w[i] = r; last = (last + 0.02 * r) / 1.02; b[i] = last * 3.5; }
    this.white = white; this.brown = brown;
    const loop = (buf, filters, gain0 = 0) => {
      const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
      src.loopStart = Math.random(); src.start(0, Math.random() * 3);
      let node = src;
      for (const f of filters) { const fl = c.createBiquadFilter(); Object.assign(fl, { type: f[0] }); fl.frequency.value = f[1]; fl.Q.value = f[2] ?? 0.7; node.connect(fl); node = fl; }
      const g = c.createGain(); g.gain.value = gain0; node.connect(g); g.connect(this.master);
      return g;
    };
    this.wind = loop(brown, [['lowpass', 420, 0.6]]);
    this.ocean = loop(white, [['lowpass', 650, 0.5], ['highpass', 90, 0.5]]);
    this.rain = loop(white, [['highpass', 1100, 0.4], ['lowpass', 7000, 0.4]]);
    this.fountain = loop(white, [['bandpass', 1600, 0.6]]);
    // crickets: a high tone chopped into pulses
    const osc = c.createOscillator(); osc.frequency.value = 4300;
    const chop = c.createGain(); chop.gain.value = 0;
    const lfo = c.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 27;
    const lfoAmt = c.createGain(); lfoAmt.gain.value = 0.5;
    lfo.connect(lfoAmt); lfoAmt.connect(chop.gain);
    osc.connect(chop);
    this.crickets = c.createGain(); this.crickets.gain.value = 0;
    chop.connect(this.crickets); this.crickets.connect(this.master);
    osc.start(); lfo.start();
    // indoors / underwater muffling for the weather beds
    this.lastPos.copy(this.g.player.pos);
  }

  setVolume() {
    if (!this.master) return;
    const s = this.g.settings;
    this.master.gain.value = s.sound === false ? 0 : (s.volume ?? 0.7);
  }

  // ---------------------------------------------------------------- one-shots
  noiseBurst(dur, filters, gain, pan = 0, when = 0) {
    const c = this.ctx, t = c.currentTime + when;
    const src = c.createBufferSource(); src.buffer = this.white;
    let node = src;
    for (const f of filters) { const fl = c.createBiquadFilter(); fl.type = f[0]; fl.frequency.value = f[1]; fl.Q.value = f[2] ?? 0.8; node.connect(fl); node = fl; }
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur / 4)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = c.createStereoPanner(); p.pan.value = pan;
    node.connect(g); g.connect(p); p.connect(this.master);
    src.start(t, Math.random() * 3, dur + 0.05);
  }
  tone(freq, dur, gain, type = 'sine', when = 0, slideTo = null, pan = 0) {
    const c = this.ctx, t = c.currentTime + when;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = c.createStereoPanner(); p.pan.value = pan;
    o.connect(g); g.connect(p); p.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  step(surface, run) {
    if (!this.ctx) return;
    const v = run ? 1.3 : 1, j = 0.85 + Math.random() * 0.3;
    switch (surface) {
      case 'grass': this.noiseBurst(0.09, [['bandpass', 1300 * j, 0.7], ['lowpass', 3500]], 0.05 * v); break;
      case 'sand': this.noiseBurst(0.12, [['bandpass', 2600 * j, 0.5]], 0.045 * v); break;
      case 'snow': this.noiseBurst(0.14, [['lowpass', 1400 * j, 1.2]], 0.07 * v); this.noiseBurst(0.06, [['highpass', 3000]], 0.015, 0, 0.03); break;
      case 'stone': this.noiseBurst(0.04, [['highpass', 1800 * j]], 0.05 * v); this.tone(140 * j, 0.05, 0.05 * v, 'sine'); break;
      case 'wood': this.tone(95 * j, 0.09, 0.09 * v, 'sine', 0, 70); this.noiseBurst(0.05, [['bandpass', 700 * j, 1.5]], 0.04 * v); break;
      case 'metal': this.tone(520 * j, 0.12, 0.025 * v, 'triangle', 0, 480); this.noiseBurst(0.04, [['highpass', 2500]], 0.03 * v); break;
      case 'water': this.noiseBurst(0.25, [['bandpass', 650 * j, 0.6]], 0.08 * v); break;
    }
  }

  // a little songbird: 2-6 quick swept notes, somewhere to the left or right
  chirp() {
    const pan = Math.random() * 1.6 - 0.8, base = 2400 + Math.random() * 2200, kind = Math.random();
    const n = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      const f = base * (kind < 0.5 ? 1 + i * 0.06 : 1.3 - i * 0.05);
      this.tone(f, 0.07 + Math.random() * 0.05, 0.012 + Math.random() * 0.012, 'sine', i * (0.09 + Math.random() * 0.05), f * (kind < 0.3 ? 1.4 : 0.75), pan);
    }
  }

  thunder(strength = 1, delay = 1) {
    if (!this.ctx) return;
    this.noiseBurst(2.8 + strength, [['lowpass', 260, 0.7]], 0.35 * strength, 0, delay);
    this.noiseBurst(0.5, [['lowpass', 900, 0.6]], 0.18 * strength, 0, delay);
  }
  splash() { if (this.ctx) this.noiseBurst(0.4, [['bandpass', 900, 0.5]], 0.12); }
  click() { if (this.ctx) this.tone(1800, 0.03, 0.04, 'square'); }
  door(open) { if (!this.ctx) return; this.tone(open ? 180 : 140, 0.25, 0.06, 'sawtooth', 0, open ? 120 : 90); this.noiseBurst(0.08, [['bandpass', 500, 1]], 0.05, 0, open ? 0.18 : 0.05); }
  harvest() { if (!this.ctx) return; this.tone(660, 0.1, 0.05, 'sine'); this.tone(990, 0.15, 0.05, 'sine', 0.08); }

  // ---------------------------------------------------------------- per frame
  surfaceUnder() {
    const p = this.g.player;
    if (p.mode === 'swim') return 'water';
    const pos = p.pos, t = this.g.terrain;
    const ground = t.heightAt(pos.x, pos.z);
    if (pos.y > ground + 0.08) {
      for (const { rec, col } of this.g.objects.colliders(pos.x, pos.z, 1)) {
        const top = p.surfaceTop(rec, col, pos.x, pos.z, 0.1);
        if (top !== null && Math.abs(top - pos.y) < 0.12) {
          const key = rec.m || ITEMS[rec.t]?.mat || '';
          return WOOD.test(key) ? 'wood' : /metal|rust|corrugated/.test(key) ? 'metal' : STONE.test(key) ? 'stone' : 'wood';
        }
      }
    }
    if (pos.y > 84) return 'snow';
    const sand = t.layerWeight(pos.x, pos.z, 3), rock = t.layerWeight(pos.x, pos.z, 2);
    return sand > 0.5 ? 'sand' : rock > 0.55 || t.normalAt(pos.x, pos.z).y < 0.8 ? 'stone' : 'grass';
  }

  update(dt) {
    if (!this.ctx) return;
    const g = this.g, p = g.player, pos = p.pos, cam = g.camera.position;
    // footsteps from distance covered on the ground
    const moved = Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z);
    this.lastPos.copy(pos);
    if ((p.onGround || p.mode === 'swim') && moved < 2 && !p.freeCam && p.mode !== 'sit') {
      this.stepDist += moved;
      const stride = p.mode === 'swim' ? 1.6 : p.speed > 4 ? 1.05 : 0.72;
      if (this.stepDist > stride) { this.stepDist = 0; this.step(this.surfaceUnder(), p.speed > 4); }
    }
    // sample the surroundings twice a second: water, trees, the fountain
    this.envTimer -= dt;
    if (this.envTimer <= 0) {
      this.envTimer = 0.5;
      let water = 0, n = 0;
      for (const r of [25, 70]) for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        if (g.terrain.heightAt(cam.x + Math.cos(a) * r, cam.z + Math.sin(a) * r) < SEA) water++;
        n++;
      }
      this.near.water = water / n;
      this.near.trees = Math.min(1, g.trees.near(cam.x, cam.z, 40).length / 25);
      this.near.fountain = g.town ? g.town.fountainNear(cam) : 0;
      this.indoors = g.weather ? g.weather.indoors : false;
    }
    const w = g.weather || { rain: 0, wind: 0.2, storm: 0 };
    const day = g.env.daylight;
    const alt = Math.max(0, cam.y - 20) / 120;
    const k = 1 - Math.exp(-dt * 2);
    const ease = (gain, v) => { gain.gain.value += (v - gain.gain.value) * k; };
    const shelter = this.indoors ? 0.35 : 1;
    ease(this.wind, (0.02 + alt * 0.25 + w.wind * 0.18 + w.storm * 0.15) * shelter);
    ease(this.ocean, this.near.water * 0.16 * (0.7 + 0.3 * Math.sin(performance.now() / 1900)) * shelter);
    ease(this.rain, w.rain * 0.13 * (this.indoors ? 0.45 : 1));
    ease(this.fountain, this.near.fountain * 0.07);
    ease(this.crickets, (1 - day) * (1 - w.rain) * (1 - this.near.water * 0.8) * 0.0045 * shelter);
    // birds sing in the daytime near trees, and not in the rain
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      const busy = day * (0.25 + this.near.trees) * (1 - w.rain) * (this.indoors ? 0.3 : 1);
      this.birdTimer = 0.8 + Math.random() * 3.5 / Math.max(0.15, busy);
      if (busy > 0.12 && Math.random() < busy) this.chirp();
    }
  }
}
