// The E key: whatever useful thing is closest in front of you. Sit on chairs, sofas, benches and beds;
// open and close doors; switch lamps on and off; harvest ripe crops; read the notice board; talk to
// the townspeople. A prompt at the bottom of the screen says what E will do.
import * as THREE from 'three';
import { ITEMS, modelSizes, modelFront } from './catalog.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Interact {
  constructor(game) {
    this.g = game;
    this.target = null;
    this.timer = 0;
    this.lightsOff = new Set();     // lamps someone switched off (shared with everyone nearby)
    this.el = document.getElementById('use-prompt');
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyE' || e.ctrlKey || game.ui.isTyping() || game.build.usesRotateKeys()) return;
      if (game.player.freeCam) return;
      if (game.vehicles.driving) { e.preventDefault(); game.vehicles.exit(); return; }
      if (this.target) { e.preventDefault(); this.use(this.target); }
    });
  }

  // ---------------------------------------------------------------- finding the target
  candidates() {
    const g = this.g, p = g.player.pos, out = [];
    const fwd = new THREE.Vector3(-Math.sin(g.player.heading), 0, -Math.cos(g.player.heading));
    const score = (pos, reach) => {
      const d = Math.hypot(pos.x - p.x, pos.z - p.z);
      if (d > reach || Math.abs(pos.y - p.y) > 3.2) return null;
      const dir = new THREE.Vector3(pos.x - p.x, 0, pos.z - p.z).normalize();
      return d - fwd.dot(dir) * 0.8; // prefer things in front
    };
    for (const id of g.objects.near(p.x, p.z, 3.5)) {
      const r = g.objects.get(id), it = r && ITEMS[r.t];
      if (!it) continue;
      const at = new THREE.Vector3(r.x, r.y, r.z);
      if (it.seat) {
        const seat = this.seatSpot(r, it);
        const s = score(seat.pos, 2.4);
        if (s !== null) out.push({ kind: 'seat', rec: r, seat, s, label: `${it.seat.bed ? 'Lie on' : 'Sit on'} the ${it.label.toLowerCase()}` });
      } else if (it.door) {
        const s = score(at.clone().setY(r.y + 1), 2.2);
        if (s !== null) out.push({ kind: 'door', rec: r, s, label: `${r.open ? 'Close' : 'Open'} the door` });
      } else if (it.light) {
        const lp = at.clone().setY(r.y + it.light.y * (r.s?.[1] || 1));
        const s = score(lp.clone().setY(Math.min(lp.y, p.y + 1)), it.hang ? 3 : 2.2);
        if (s !== null) out.push({ kind: 'light', rec: r, s: s + 0.3, label: `Turn the ${it.label.toLowerCase()} ${this.isOff(r) ? 'on' : 'off'}` });
      } else if (it.crop && g.objects.growth(r) >= 1) {
        const s = score(at, 2);
        if (s !== null) out.push({ kind: 'crop', rec: r, s, label: `Harvest the ${it.crop.name}` });
      }
    }
    // vehicles: walk up to the side and get in (boats from the shore or a pier)
    for (const v of g.vehicles.items.values()) {
      const reach = v.type === 'bike' ? 2 : v.type === 'boat' ? 4.2 : 3.2;
      const s = score(new THREE.Vector3(v.pose.x, v.pose.y + 0.5, v.pose.z), reach);
      if (s === null) continue;
      const busy = g.vehicles.driverOf(v) !== null;
      out.push({ kind: 'vehicle', v, s: s + 0.1, label: busy ? `Someone is using this ${v.T.label}` : `${v.T.verb} the ${v.T.label}` });
    }
    if (g.town) for (const ia of g.town.interactables) {
      const s = score(ia.pos, ia.kind === 'npc' ? 2.6 : 2.4);
      if (s !== null) out.push({ ...ia, s: s - 0.2 });
    }
    return out;
  }

  // the free spot on a seat nearest the player: sofas and benches have several
  seatSpot(r, it) {
    const sz = modelSizes.get(it.model) || [1, 1, 1];
    const n = it.seat.n || 1, w = sz[0] * (r.s?.[0] || 1);
    const fz = modelFront.get(it.model) ?? 1;
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(UP, r.ry), front = new THREE.Vector3(0, 0, fz).applyAxisAngle(UP, r.ry);
    const p = this.g.player.pos;
    let best = null;
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * w * 0.7;
      const pos = new THREE.Vector3(r.x, r.y + it.seat.h * (r.s?.[1] || 1), r.z).addScaledVector(right, off).addScaledVector(front, it.seat.dz || 0.05);
      const d = pos.distanceToSquared(p);
      // an avatar with heading h faces (-sin h, -cos h); turn it to look the way the seat faces
      if (!best || d < best.d) best = { pos, d, heading: r.ry + (fz > 0 ? Math.PI : 0) };
    }
    return best;
  }

  isOff(r) { return !!r.off || this.lightsOff.has(r.id); }

  // ---------------------------------------------------------------- doing it
  use(t) {
    const g = this.g;
    switch (t.kind) {
      case 'seat': {
        g.player.sitAt(t.seat.pos.x, t.seat.pos.y - 0.47, t.seat.pos.z, t.seat.heading);
        g.myEmote = null; g.myAvatar.setEmote(null);
        g.sendState(true);
        g.event('sit');
        break;
      }
      case 'door': this.toggleDoor(t.rec); break;
      case 'light': {
        const off = !this.isOff(t.rec);
        this.setLight(t.rec.id, off);
        if (g.canModify(t.rec)) g.putObject({ ...t.rec, off: off || undefined });
        g.sendAction({ k: 'light', id: t.rec.id, off });
        g.sound && g.sound.click();
        break;
      }
      case 'crop': {
        const r = t.rec, it = ITEMS[r.t];
        if (!g.canModify(r) && r.owner !== 'town') { g.ui.toast(`Those belong to ${g.ownerName(r.owner)}`, 'warn'); break; }
        if (r.owner === 'town') { g.ui.toast('The town flowers are for everyone to enjoy'); break; }
        g.putObject({ ...r, pt: g.now() });          // replant: it grows again
        const basket = g.store.get('basket', {});
        basket[it.crop.name] = (basket[it.crop.name] || 0) + 1;
        g.store.set('basket', basket);
        g.ui.toast(`Harvested ${it.crop.name}! Basket: ${Object.entries(basket).map(([k, v]) => `${v} ${k}`).join(', ')}`);
        g.sound && g.sound.harvest();
        g.event('harvest');
        break;
      }
      case 'board': g.ui.openNotices(); break;
      case 'vehicle': g.vehicles.enter(t.v); break;
      case 'npc': {
        const line = g.town.talk(t.person);
        g.ui.npcDialog(t.person, line);
        g.event('talk', t.person.def.name);
        break;
      }
    }
    this.timer = 0;
  }

  // A door swings 90° about its hinge (its local -x edge, 0.53 m from the centre): opening turns it +90°,
  // closing turns it back. Builders' changes are saved; anyone else's swing is shared live but not saved.
  toggleDoor(r) {
    const g = this.g;
    const open = !r.open;
    const half = 0.53 * (r.s?.[0] || 1);
    const hinge = new THREE.Vector3(r.x, 0, r.z).add(new THREE.Vector3(-half, 0, 0).applyAxisAngle(UP, r.ry));
    const ry = r.ry + (open ? 1 : -1) * Math.PI / 2;
    const centre = hinge.clone().sub(new THREE.Vector3(-half, 0, 0).applyAxisAngle(UP, ry));
    const next = { ...r, ry, x: centre.x, z: centre.z, open: open || undefined };
    delete next._pool;
    if (g.canModify(r)) g.putObject(next);
    else { g.objects.set(next); g.sendAction({ k: 'door', id: r.id, x: next.x, z: next.z, ry, open }); }
    g.sound && g.sound.door(open);
  }

  setLight(id, off) { if (off) this.lightsOff.add(id); else this.lightsOff.delete(id); }

  // someone else used something
  onAction(a) {
    const g = this.g;
    if (a.k === 'veh') { g.vehicles.onAction(a); return; }
    if (a.k === 'door') {
      const r = g.objects.get(a.id);
      if (r) { const n = { ...r, x: a.x, z: a.z, ry: a.ry, open: a.open || undefined }; delete n._pool; g.objects.set(n); g.sound && g.player.pos.distanceTo(new THREE.Vector3(r.x, r.y, r.z)) < 20 && g.sound.door(a.open); }
    } else if (a.k === 'light') this.setLight(a.id, a.off);
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.15;
      const g = this.g;
      let best = null;
      if (!g.player.freeCam && g.player.mode !== 'sit' && !g.vehicles.driving && g.build.mode !== 'house') {
        for (const c of this.candidates()) if (!best || c.s < best.s) best = c;
      }
      this.target = best;
      if (g.vehicles.driving) this.show(`Get out of the ${g.vehicles.driving.T.label}`);
      else if (g.player.mode === 'sit') this.show('Move to stand up');
      else this.show(best ? best.label : '');
    }
  }

  show(text) {
    if (this.shown === text) return;
    this.shown = text;
    this.el.innerHTML = text ? (text.startsWith('Move') ? text : `<kbd>E</kbd> ${text}`) : '';
    this.el.classList.toggle('show', !!text);
  }
}
