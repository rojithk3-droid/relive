// The welcome tour: a short checklist that teaches the basics by doing them, and the free starter home
// (Mira finds you an empty plot near town, claims it, and builds you a furnished cottage on it).
import * as THREE from 'three';
import { PLOT, TOWN, HALF, SEA, plotKey } from './config.js';
import { generateHouse } from './houses.js';

export const STEPS = [
  { id: 'talk',  text: 'Say hello to Mira, the guide by the fountain', hint: 'Walk up to her and press E' },
  { id: 'look',  text: 'Look around', hint: 'Right-drag (or drag) the view' },
  { id: 'chat',  text: 'Say hi in chat', hint: 'Press Enter, type, Enter again' },
  { id: 'sit',   text: 'Sit on a bench', hint: 'Walk up to one and press E' },
  { id: 'home',  text: 'Get your free home', hint: 'Ask Mira, or press the button below' },
  { id: 'place', text: 'Decorate: place something', hint: 'Build tool (2): pick an item, click to place' },
  { id: 'plant', text: 'Plant something in the garden', hint: 'Build tool (2) > Garden. It grows in 8 minutes' },
  { id: 'photo', text: 'Take a photo', hint: 'The aperture button at the top, or K' },
  { id: 'wave',  text: 'Wave at someone', hint: 'Type /wave in chat' },
];

export class Quests {
  constructor(game) {
    this.g = game;
    this.key = 'quests.' + game.profileKey;
    this.done = new Set(game.store.get(this.key, []));
    this.hidden = game.store.get(this.key + '.hidden', false);
    this.startYaw = null;
  }

  event(name) {
    const map = { talk: 'talk', chat: 'chat', sit: 'sit', home: 'home', place: 'place', plant: 'plant', photo: 'photo', wave: 'wave' };
    const id = map[name];
    if (id) this.complete(id);
  }

  complete(id) {
    if (this.done.has(id) || !STEPS.some((s) => s.id === id)) return;
    this.done.add(id);
    this.g.store.set(this.key, [...this.done]);
    const step = STEPS.find((s) => s.id === id);
    this.g.ui.toast(`✓ ${step.text}`);
    this.g.sound && this.g.sound.harvest();
    if (this.done.size === STEPS.length) this.g.ui.toast('Welcome tour complete - you\'re a resident of ReLive now!');
    this.render();
  }

  update() {
    // "look around" counts once the camera has turned a fair way
    const yaw = this.g.player.camYaw;
    if (this.startYaw === null) this.startYaw = yaw;
    else if (!this.done.has('look') && Math.abs(yaw - this.startYaw) > 1.2) this.complete('look');
  }

  render() {
    const el = document.getElementById('quests');
    if (!el) return;
    const all = this.done.size === STEPS.length;
    el.classList.toggle('show', !this.hidden && !all);
    el.classList.toggle('collapsed', !!this.collapsed);
    const next = STEPS.find((s) => !this.done.has(s.id));
    el.innerHTML = `
      <div class="q-head"><b>Welcome tour</b><span class="muted">${this.done.size}/${STEPS.length}</span>
        <button data-q="fold" title="Fold">${this.collapsed ? '▸' : '▾'}</button><button data-q="hide" title="Hide the tour">×</button></div>
      ${this.collapsed ? (next ? `<div class="q-next">${next.text}</div>` : '') : `<ol>${STEPS.map((s) => `<li class="${this.done.has(s.id) ? 'done' : s === next ? 'next' : ''}"><span>${s.text}</span>${s === next ? `<small>${s.hint}</small>` : ''}</li>`).join('')}</ol>
      ${!this.done.has('home') ? '<button class="q-home" data-q="home">Get my free home</button>' : ''}`}`;
    el.onclick = (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      if (b.dataset.q === 'fold') { this.collapsed = !this.collapsed; this.render(); }
      if (b.dataset.q === 'hide') { this.hidden = true; this.g.store.set(this.key + '.hidden', true); this.render(); this.g.ui.toast('Tour hidden - type /tour to bring it back'); }
      if (b.dataset.q === 'home') this.starterHome();
    };
  }

  show() { this.hidden = false; this.g.store.set(this.key + '.hidden', false); this.render(); }

  // ---------------------------------------------------------------- free starter home
  // the nearest empty plot of good land outside town, claimed in your name, with a cottage built on it
  findPlot() {
    const g = this.g, t = g.terrain;
    const c = { x: TOWN.x, z: TOWN.z };
    const cands = [];
    for (let i = -14; i < 14; i++) for (let j = -14; j < 14; j++) {
      const o = { x: i * PLOT, z: j * PLOT };
      const cx = o.x + PLOT / 2, cz = o.z + PLOT / 2;
      const d = Math.hypot(cx - c.x, cz - c.z);
      if (d < TOWN.r + 30 || Math.abs(cx) > HALF - 40 || Math.abs(cz) > HALF - 40) continue;
      cands.push({ key: i + ',' + j, cx, cz, d });
    }
    cands.sort((a, b) => a.d - b.d);
    for (const p of cands) {
      if (g.plots.has(p.key)) continue;
      // dry, gentle ground, nothing built by anyone else
      let ok = true;
      for (const [dx, dz] of [[-10, -8], [10, -8], [-10, 8], [10, 8], [0, 0]]) {
        const h = t.heightAt(p.cx + dx, p.cz + dz);
        if (h < SEA + 1.2 || h > 60 || t.normalAt(p.cx + dx, p.cz + dz).y < 0.9) ok = false;
      }
      if (!ok) continue;
      for (const id of g.objects.near(p.cx, p.cz, PLOT * 0.75)) {
        const r = g.objects.get(id);
        if (r && r.t !== 'cut' && r.owner !== g.me.uid && plotKey(r.x, r.z) === p.key) { ok = false; break; }
      }
      if (ok) return p;
    }
    return null;
  }

  starterHome() {
    const g = this.g;
    if (g.store.get('home.' + g.profileKey, null) && this.done.has('home')) { g.ui.toast('You already have a home - type /home to go there'); return; }
    const mine = [...g.plots.entries()].filter(([, p]) => p.owner === g.me.uid);
    if (mine.length >= 6) { g.ui.toast('You already own 6 plots', 'warn'); return; }
    const p = this.findPlot();
    if (!p) { g.ui.toast('No free land found near town - try the Land tool (7)', 'warn'); return; }
    g.ui.toast('Mira is finding you a plot…');
    // build once the server confirms the claim
    this.pendingHome = p;
    g.claimPlot(p.key, `${g.profile.name}'s home`, false);
    if (g.net.offline) setTimeout(() => this.onPlot(p.key), 50);
  }

  onPlot(key) {
    const p = this.pendingHome;
    if (!p || p.key !== key) return;
    const pl = this.g.plots.get(key);
    if (!pl || pl.owner !== this.g.me.uid) return;
    this.pendingHome = null;
    const g = this.g, t = g.terrain;
    // face the door toward town
    const dx = TOWN.x - p.cx, dz = TOWN.z - p.cz;
    const front = Math.abs(dz) >= Math.abs(dx) ? (dz > 0 ? 0 : 2) : dx > 0 ? 1 : 3;
    const swap = front % 2 === 1;
    const w = swap ? 8 : 12, d = swap ? 12 : 8;
    const x0 = Math.round((p.cx - w / 2) / 4) * 4, z0 = Math.round((p.cz - d / 2) / 4) * 4;
    const f = { x0, x1: x0 + w, z0, z1: z0 + d, front };
    const baseY = Math.max(t.averageHeight(f.x0, f.z0, f.x1, f.z1), SEA + 0.3);
    g.terrainOp({ k: 'level', x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2, r: 11, s: 1, y: baseY - 0.05 });
    // clear the trees off the footprint
    for (const tr of g.trees.near(p.cx, p.cz, 14)) if (/^n\d+$/.test(tr.id)) g.putObject({ id: g.newId(), t: 'cut', ref: tr.id, x: tr.x, y: tr.y, z: tr.z });
    const gid = 'h' + g.newId();
    const recs = generateHouse({ ...f, baseY, floors: 1, style: 'cottage', furnish: true }).map((r) => ({ ...r, id: g.newId(), g: gid }));
    for (const r of recs) g.putObject(r);
    // a little garden beside the front steps, and you standing on the path looking at your house
    const steps = recs.find((r) => r.t === 'stairs_wide');
    if (steps) {
      const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
      const out = new THREE.Vector2(steps.x - cx, steps.z - cz).normalize();
      const side = new THREE.Vector2(-out.y, out.x);
      ['sunflower', 'tomato', 'flowers'].forEach((k, i) => {
        const x = steps.x + side.x * (3 + i * 1.1) + out.x * 0.5, z = steps.z + side.y * (3 + i * 1.1) + out.y * 0.5;
        g.putObject({ id: g.newId(), t: 'crop:' + k, x, z, y: t.heightAt(x, z), ry: i, pt: g.now() });
      });
      const home = { x: steps.x + out.x * 4, z: steps.z + out.y * 4 };
      g.store.set('home.' + g.profileKey, home);
      g.teleport(home.x, home.z);
      g.player.camYaw = Math.atan2(out.x, out.y);
    }
    g.ui.toast('Your new home is ready! Type /home any time to come back.');
    this.complete('home');
  }
}

export function homeOf(game) { return game.store.get('home.' + game.profileKey, null); }
