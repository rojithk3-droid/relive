// Everything on screen that isn't the 3D world: avatar creator, top bar, tool rail, chat, people,
// player cards, minimap + world map (click to teleport), settings, help, toasts and little sounds.
import * as THREE from 'three';
import { MODES } from './build.js';
import { BODIES } from './assets.js';
import { HATS } from './avatar.js';
import { KINDS as WEATHER } from './weather.js';
import { homeOf } from './quests.js';
import { HALF, N, CELL, SEA, PLOT, plotOrigin } from './config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s) => document.querySelector(s);
const OUTFITS = ['#ffffff', '#d9534f', '#f0ad4e', '#f2d16b', '#5cb85c', '#3fb8af', '#4a90e2', '#7b6cd9', '#c36ad6', '#8d6e63', '#555b66', '#222831'];
const STRONG = ['fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'slut', 'whore'];

export class UI {
  constructor(game) {
    this.g = game;
    this.typing = false;
    this.friends = new Set(game.store.get('friends', []));
    this.muted = new Set(game.store.get('muted', []));
    this.chatTab = 'all';
    this.unread = 0;
    this.mapImg = null;
    this.mapDirty = true;
    this.refreshMinimap = true;
    this.buildChrome();
    game.terrain.onChange = () => { this.mapDirty = true; };
  }

  // called once the game has finished constructing (the tools reach back into game.ui)
  boot() {
    if (this.g.profile) this.enter(this.g.profile);
    else this.showWelcome(true);
  }

  // ---------------------------------------------------------------- chrome
  buildChrome() {
    const rail = $('#modes');
    rail.innerHTML = MODES.map((m) => `<button data-mode="${m.id}" title="${m.label} (${m.key})"><svg viewBox="0 0 24 24"><path d="${m.icon}"/></svg><kbd>${m.key}</kbd></button>`).join('');
    rail.onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) this.g.build.setMode(b.dataset.mode); };
    $('#btn-photo').onclick = () => this.enterPhoto();
    $('#photo-take').onclick = () => this.g.takePhoto();
    $('#photo-names').onclick = () => document.body.classList.toggle('photo-names');
    $('#photo-exit').onclick = () => this.exitPhoto();
    $('#btn-voice').onclick = async () => {
      const v = this.g.voice;
      if (!v.on) { if (await v.enable()) document.body.classList.add('voice-on'); }
      else if (!v.muted) { v.setMuted(true); document.body.classList.add('voice-muted'); this.toast('Microphone muted - click again to turn voice off'); }
      else { v.setMuted(false); v.disable(); document.body.classList.remove('voice-on', 'voice-muted'); this.toast('Voice chat off'); }
    };
    $('#notice-post').onclick = () => {
      const t = $('#notice-text').value.trim();
      if (!t) return;
      this.g.postNote(t);
      $('#notice-text').value = '';
    };
    $('#notice-text').onkeydown = (e) => e.stopPropagation();
    $('#chat-hide').onclick = () => this.setChatHidden(true);
    $('#chat-open').onclick = () => { this.setChatHidden(false); $('#chat-input').focus(); };
    this.setChatHidden(!!this.g.settings.chatHidden);
    $('#btn-cam').onclick = () => this.g.player.setFreeCam(!this.g.player.freeCam);
    $('#cam-exit').onclick = () => this.g.player.setFreeCam(false);
    $('#btn-people').onclick = () => this.toggle('#people');
    $('#btn-map').onclick = () => this.openMap();
    $('#btn-settings').onclick = () => this.openSettings();
    $('#btn-help').onclick = () => this.toggle('#help');
    $('#side-toggle').onclick = () => document.body.classList.toggle('side-collapsed');
    document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('.modal, .float').classList.remove('show')));
    $('#minimap').onclick = () => this.openMap();

    // chat
    const input = $('#chat-input');
    input.addEventListener('focus', () => { this.typing = true; document.body.classList.add('chatting'); this.unread = 0; this.updateUnread(); });
    input.addEventListener('blur', () => { this.typing = false; document.body.classList.remove('chatting'); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.sendChat(input.value); input.value = ''; input.blur(); e.preventDefault(); }
      if (e.key === 'Escape') { input.value = ''; input.blur(); }
      e.stopPropagation();
    });
    document.querySelectorAll('#chat .ctab').forEach((b) => (b.onclick = () => { this.chatTab = b.dataset.tab; document.querySelectorAll('#chat .ctab').forEach((x) => x.classList.toggle('on', x === b)); this.filterChat(); }));
    addEventListener('keydown', (e) => {
      if (this.isTyping()) return;
      if (e.key === 'Enter' && this.g.ready) { e.preventDefault(); this.setChatHidden(false); input.focus(); }
      else if (e.key === '/' && this.g.ready) { e.preventDefault(); this.setChatHidden(false); input.focus(); input.value = '/'; }
      else if (e.code === 'Escape' && document.body.classList.contains('photo')) this.exitPhoto();
      else if (e.code === 'KeyK' && !e.ctrlKey && this.g.ready) document.body.classList.contains('photo') ? this.g.takePhoto() : this.enterPhoto();
      else if (e.code === 'KeyM' && !e.ctrlKey) this.openMap();
      else if (e.code === 'KeyP' && !e.ctrlKey) this.toggle('#people');
      else if (e.code === 'KeyH' && !e.ctrlKey) this.toggle('#help');
      else if (e.code === 'Tab') { e.preventDefault(); document.body.classList.toggle('side-collapsed'); }
    });

    // world map: click to teleport
    $('#map-canvas').onclick = (e) => {
      const c = e.target, r = c.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 * HALF - HALF, z = ((e.clientY - r.top) / r.height) * 2 * HALF - HALF;
      if (this.g.terrain.heightAt(x, z) < SEA - 1.5) { this.toast('That is open water - pick a spot on land'); return; }
      this.g.teleport(x, z);
      $('#map').classList.remove('show');
      this.toast('Teleported');
    };
  }

  toggle(sel) {
    const el = $(sel);
    el.classList.toggle('show');
    if (sel === '#people' && el.classList.contains('show')) this.refreshPeople();
  }

  isTyping() { const a = document.activeElement; return this.typing || (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && a.type !== 'range' && a.type !== 'checkbox' && a.type !== 'color'); }

  // ---------------------------------------------------------------- welcome / avatar
  showWelcome(first) {
    const p = this.g.profile || { name: '', body: 'soldier', color: '#ffffff' };
    const w = $('#welcome');
    w.querySelector('.intro').style.display = first ? '' : 'none';
    w.querySelector('#w-title').textContent = first ? 'Welcome to ReLive' : 'Your avatar';
    $('#w-name').value = p.name;
    $('#w-bodies').innerHTML = Object.entries(BODIES).map(([k, b]) => `<button class="chip ${k === p.body ? 'on' : ''}" data-body="${k}">${b.label}</button>`).join('');
    $('#w-colors').innerHTML = OUTFITS.map((c) => `<button class="sw ${c === p.color ? 'on' : ''}" data-color="${c}" style="background:${c}"></button>`).join('');
    let body = p.body, color = p.color;
    $('#w-bodies').onclick = (e) => { const b = e.target.closest('[data-body]'); if (!b) return; body = b.dataset.body; $('#w-bodies').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); };
    $('#w-colors').onclick = (e) => { const b = e.target.closest('[data-color]'); if (!b) return; color = b.dataset.color; $('#w-colors').querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b)); };
    $('#w-hat').innerHTML = Object.entries(HATS).map(([k, l]) => `<option value="${k}" ${k === (p.hat || 'none') ? 'selected' : ''}>${l}</option>`).join('');
    $('#w-hatcolor').value = p.hatColor || '#3a5a8c';
    $('#w-glasses').checked = !!p.glasses;
    $('#w-height').value = p.height || 1;
    $('#w-height-v').textContent = (+(p.height || 1)).toFixed(2);
    $('#w-height').oninput = () => { $('#w-height-v').textContent = (+$('#w-height').value).toFixed(2); };
    $('#w-go').textContent = first ? 'Enter the world' : 'Save';
    $('#w-go').onclick = () => {
      const name = $('#w-name').value.trim().replace(/\s+/g, ' ').slice(0, 24);
      if (name.length < 2) { $('#w-name').focus(); $('#w-name').classList.add('bad'); return; }
      const prof = { name, body, color, hat: $('#w-hat').value, hatColor: $('#w-hatcolor').value, glasses: $('#w-glasses').checked || undefined, height: +$('#w-height').value };
      w.classList.remove('show');
      if (first) this.enter(prof); else this.g.updateProfile(prof);
    };
    $('#w-name').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') $('#w-go').click(); };
    if (first || this.g.ready) w.classList.add('show');
  }

  enter(profile) {
    $('#loading').classList.add('show');
    $('#loading .msg').textContent = 'Connecting to the world…';
    this.g.start(profile);
    this.g.build.setMode('explore');
  }

  onReady() {
    $('#loading').classList.remove('show');
    document.body.classList.add('ready');
    this.mapDirty = true;
    const n = this.g.players.size;
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    this.system(this.g.net.offline
      ? local
        ? 'Playing solo: no world server is running, so your world is saved in this browser only. Start "Play ReLive.cmd" to share it.'
        : 'Playing solo: this page has no shared world server connected yet, so your builds are saved in this browser only and other visitors can\'t see you.'
      : `Welcome, ${this.g.profile.name}. ${n ? n + (n === 1 ? ' other resident is' : ' other residents are') + ' online.' : 'You are the first one here.'} Press Enter to chat, H for help.`);
  }

  setStatus(s) {
    const el = $('#status');
    el.className = 'pill ' + s;
    el.dataset.state = s;
    this.updateStatus();
  }
  updateStatus() {
    const el = $('#status'), s = el.dataset.state;
    el.textContent = s === 'online' ? `${this.g.players.size + 1} online` : s === 'offline' ? 'Solo (offline)' : 'Reconnecting…';
  }

  onMode(m) {
    document.querySelectorAll('#modes [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    document.body.dataset.mode = m;
    // exploring keeps the view clear; every tool opens its panel
    document.body.classList.toggle('side-collapsed', m === 'explore');
    this.hint('');
  }

  // ---------------------------------------------------------------- chat
  filterWords(t) {
    if (this.g.settings.filter === false) return t;
    return t.replace(new RegExp(`\\b(${STRONG.join('|')})\\w*`, 'gi'), (m) => m[0] + '*'.repeat(m.length - 1));
  }

  sendChat(text) {
    text = text.trim();
    if (!text) return;
    const g = this.g;
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(' ');
      const arg = rest.join(' ');
      const emotes = ['wave', 'cheer', 'clap', 'point', 'dance', 'sit'];
      if (emotes.includes(cmd)) { g.emote(cmd); g.chat({ text: `/${cmd}`, emote: cmd }); g.event(cmd); return; }
      if (cmd === 'tour') { g.quests.show(); return; }
      if (cmd === 'photo') { this.enterPhoto(); return; }
      if (cmd === 'weather') {
        if (!arg) { const f = g.weather.forecast(g.now()); this.system(`Weather: ${WEATHER[g.weather.kind].label}. Next: ${WEATHER[f.next].label} in about ${f.minutes} min. (/weather clear|cloudy|rain|storm|fog|world changes only your view)`); return; }
        if (arg === 'world' || WEATHER[arg]) { g.settings.weather = arg === 'world' ? '' : arg; g.store.set('settings', g.settings); this.system(arg === 'world' ? 'Following the shared weather' : `Your view now shows: ${WEATHER[arg].label}`); }
        else this.system('Weather options: clear, cloudy, rain, storm, fog, world');
        return;
      }
      if (cmd === 'me') { g.chat({ text: arg, me: true }); return; }
      if (cmd === 'w' || cmd === 'msg') {
        const m = arg.match(/^"([^"]+)"\s+(.+)$/) || arg.match(/^(\S+)\s+(.+)$/);
        if (!m) { this.system('Usage: /w name message'); return; }
        const pl = [...g.players.values()].find((p) => (p.profile.name || '').toLowerCase() === m[1].toLowerCase()) || [...g.players.values()].find((p) => (p.profile.name || '').toLowerCase().startsWith(m[1].toLowerCase()));
        if (!pl) { this.system(`Nobody called "${m[1]}" is online`); return; }
        g.whisper(pl.sid, m[2]);
        return;
      }
      if (cmd === 'near' || cmd === 'l') { g.chat({ text: arg, near: true }); return; }
      if (cmd === 'tp' || cmd === 'goto') {
        const pl = [...g.players.values()].find((p) => (p.profile.name || '').toLowerCase().startsWith(arg.toLowerCase()));
        if (pl) { g.teleport(pl.pos.x + 2, pl.pos.z + 2); this.system(`Visiting ${pl.profile.name}`); } else this.system('Nobody by that name is online');
        return;
      }
      if (cmd === 'home') { const h = homeOf(g); if (h) g.teleport(h.x, h.z); else { g.teleport(0, 70); this.system('You don\'t have a home yet - ask Mira at the fountain, or use the welcome tour. Took you to town.'); } return; }
      if (cmd === 'town') { g.teleport(0, 70); return; }
      if (cmd === 'time') { this.setTime(arg); return; }
      this.system('Commands: /w name msg · /near msg · /me action · /wave /cheer /clap /point /dance /sit · /tp name · /home · /town · /tour · /photo · /weather · /time noon|sunset|night|morning|world');
      return;
    }
    g.chat({ text: text.slice(0, 400), near: this.chatTab === 'near' });
    g.event('chat');
  }

  setTime(v) {
    if (!['world', 'morning', 'noon', 'sunset', 'night'].includes(v)) { this.system('Times: world, morning, noon, sunset, night'); return; }
    this.g.settings.time = v; this.g.store.set('settings', this.g.settings);
    this.system(v === 'world' ? 'Following the shared world clock' : `Your view is now fixed at ${v} (others still see the world clock)`);
  }

  chatLine(m, history) {
    if (this.muted.has(m.uid)) return;
    const name = this.g.users.get(m.uid) || m.n || 'Resident';
    const mine = m.uid === this.g.me.uid;
    let html;
    const text = this.filterWords(m.text || '');
    if (m.emote) html = `<span class="em">${esc(name)} ${esc(m.emote === 'sit' ? 'sits down' : m.emote === 'dance' ? 'dances' : m.emote + 's')}</span>`;
    else if (m.me) html = `<span class="em">${esc(name)} ${esc(text)}</span>`;
    else html = `<b style="color:${this.nameColor(m.uid)}">${esc(name)}</b> ${esc(text)}`;
    if (m.near && !mine && this.g.distanceTo(m.sid) > 40 && !history) return;
    this.addLine(html, m.near ? 'near' : 'all', m.time, mine, history);
    if (!history && !mine && !m.emote) this.sound('chat');
  }

  whisperLine(from, to, m) {
    const g = this.g;
    const out = from === g.me.sid;
    const other = out ? g.players.get(to) : g.players.get(from);
    if (!out && other && this.muted.has(other.uid)) return;
    const name = other ? other.profile.name : 'someone';
    this.addLine(`<span class="wh">${out ? `to ${esc(name)}` : `${esc(name)} whispers`}:</span> ${esc(this.filterWords(m.text))}`, 'whisper', Date.now(), out);
    if (!out) { this.sound('chat'); this.toast(`${name} whispers: ${m.text.slice(0, 60)}`); }
  }

  system(text) { this.addLine(`<span class="sys">${esc(text)}</span>`, 'sys', Date.now(), true); }

  addLine(html, kind, time, mine, history) {
    const log = $('#chat-log');
    const d = document.createElement('div');
    d.className = 'line ' + kind;
    d.dataset.kind = kind;
    const t = new Date(time || Date.now());
    d.innerHTML = `<time>${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}</time>${html}`;
    log.appendChild(d);
    while (log.children.length > 200) log.firstChild.remove();
    this.filterChat(d);
    log.scrollTop = log.scrollHeight;
    if (!mine && !history && !this.typing) { this.unread++; this.updateUnread(); }
    document.body.classList.add('chat-recent');
    clearTimeout(this.chatFade);
    this.chatFade = setTimeout(() => document.body.classList.remove('chat-recent'), 9000);
  }

  filterChat(only) {
    const show = (el) => { const k = el.dataset.kind; el.style.display = this.chatTab === 'all' || k === 'sys' || k === this.chatTab ? '' : 'none'; };
    if (only) show(only); else $('#chat-log').querySelectorAll('.line').forEach(show);
  }
  updateUnread() {
    for (const b of [$('#chat-unread'), $('#chat-open-badge')]) { b.textContent = this.unread > 99 ? '99+' : this.unread; b.style.display = this.unread ? '' : 'none'; }
  }

  // the chat box can be folded away to a round button; the choice is remembered
  setChatHidden(hidden) {
    document.body.classList.toggle('chat-hidden', hidden);
    if (!!this.g.settings.chatHidden !== hidden) { this.g.settings.chatHidden = hidden; this.g.store.set('settings', this.g.settings); }
    if (hidden) $('#chat-input').blur();
    else { this.unread = 0; this.updateUnread(); const log = $('#chat-log'); log.scrollTop = log.scrollHeight; }
  }

  nameColor(uid) {
    let h = 0;
    for (const c of uid || 'x') h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360},70%,72%)`;
  }

  // ---------------------------------------------------------------- people
  refreshPeople() {
    this.updateStatus();
    const el = $('#people-list');
    if (!el || !$('#people').classList.contains('show')) return;
    const g = this.g;
    const rows = [...g.players.values()].sort((a, b) => g.distanceTo(a.sid) - g.distanceTo(b.sid)).map((p) => {
      const d = g.distanceTo(p.sid);
      return `<div class="person"><span class="dot" style="background:${esc(p.profile.color || '#fff')}"></span>
        <span class="nm">${esc(p.profile.name)}${this.friends.has(p.uid) ? ' <i class="fr">friend</i>' : ''}</span><span class="muted">${d < 1000 ? Math.round(d) + ' m' : ''}</span>
        <button class="chip" data-p="card" data-sid="${p.sid}">Profile</button></div>`;
    }).join('');
    el.innerHTML = `<div class="person me"><span class="dot" style="background:${esc(g.profile.color)}"></span><span class="nm">${esc(g.profile.name)} (you)</span><button class="chip" data-p="avatar">Edit avatar</button></div>${rows || '<p class="muted">Nobody else is here right now. Share the address so friends can join.</p>'}`;
    el.onclick = (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      if (b.dataset.p === 'avatar') this.showWelcome(false);
      else this.showPlayerCard(+b.dataset.sid);
    };
  }

  showPlayerCard(sid) {
    const g = this.g, p = g.players.get(sid);
    if (!p) return;
    const card = $('#card');
    const fr = this.friends.has(p.uid), mu = this.muted.has(p.uid);
    const plots = [...g.plots.entries()].filter(([, pl]) => pl.owner === p.uid);
    card.querySelector('.body').innerHTML = `
      <div class="who"><span class="dot big" style="background:${esc(p.profile.color || '#fff')}"></span><div><h3>${esc(p.profile.name)}</h3><span class="muted">${Math.round(g.distanceTo(sid))} m away${plots.length ? ` · owns ${plots.length} plot${plots.length > 1 ? 's' : ''}` : ''}</span></div></div>
      <div class="btn-row">
        <button data-c="wave">Wave</button>
        <button data-c="msg" class="ghost">Message</button>
        <button data-c="visit" class="ghost">Go to</button>
      </div>
      ${plots.length ? `<div class="list">${plots.map(([k, pl]) => `<button class="list-row" data-c="plot" data-k="${k}"><span>${esc(pl.name || 'Plot ' + k)}</span><span class="muted">visit</span></button>`).join('')}</div>` : ''}
      <div class="btn-row"><button data-c="friend" class="ghost">${fr ? 'Remove friend' : 'Add friend'}</button><button data-c="mute" class="ghost danger">${mu ? 'Unmute' : 'Mute'}</button></div>`;
    card.querySelector('.body').onclick = (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      const c = b.dataset.c;
      if (c === 'wave') { g.emote('wave'); g.chat({ text: '/wave', emote: 'wave' }); }
      if (c === 'msg') { const i = $('#chat-input'); i.focus(); i.value = `/w "${p.profile.name}" `; card.classList.remove('show'); }
      if (c === 'visit') { g.teleport(p.pos.x + 2, p.pos.z + 2); card.classList.remove('show'); }
      if (c === 'plot') { const o = plotOrigin(b.dataset.k); g.teleport(o.x + PLOT / 2, o.z + PLOT / 2); card.classList.remove('show'); }
      if (c === 'friend') { fr ? this.friends.delete(p.uid) : this.friends.add(p.uid); g.store.set('friends', [...this.friends]); this.showPlayerCard(sid); }
      if (c === 'mute') { mu ? this.muted.delete(p.uid) : this.muted.add(p.uid); g.store.set('muted', [...this.muted]); this.showPlayerCard(sid); }
    };
    card.classList.add('show');
  }

  // ---------------------------------------------------------------- settings
  openSettings() {
    const s = this.g.settings, m = $('#settings');
    m.querySelector('.body').innerHTML = `
      <label class="field">Graphics<select data-s="quality">${[['auto', `Auto (${this.g.detected.q} for this graphics chip)`], ['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra (gaming PCs)']].map(([k, l]) => `<option value="${k}" ${k === s.quality ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="muted small-note">Graphics chip: ${esc(this.g.detected.gpu || 'unknown')} · now ${this.g.fps ? Math.round(this.g.fps) + ' fps' : 'measuring…'} at ${Math.round(this.g.resScale * 100)}% resolution</p>
      <label class="check"><input type="checkbox" data-s="adaptive" ${s.adaptive !== false ? 'checked' : ''}> Dynamic resolution (keeps it smooth by lowering sharpness when busy)</label>
      <label class="field">Time of day<select data-s="time">${[['world', 'Shared world clock'], ['morning', 'Always morning'], ['noon', 'Always noon'], ['sunset', 'Always sunset'], ['night', 'Always night']].map(([k, l]) => `<option value="${k}" ${k === s.time ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Weather<select data-s="weather">${[['', 'Shared world weather'], ...Object.entries(WEATHER).map(([k, w]) => [k, 'Always ' + w.label.toLowerCase()])].map(([k, l]) => `<option value="${k}" ${k === (s.weather || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="slider">Volume<input type="range" min="0" max="1" step="0.05" value="${s.volume ?? 0.7}" data-s="volume"><span>${Math.round((s.volume ?? 0.7) * 100)}</span></label>
      <label class="check"><input type="checkbox" data-s="sound" ${s.sound !== false ? 'checked' : ''}> World sounds (wind, birds, rain, footsteps)</label>
      <label class="slider">Mouse speed<input type="range" min="0.3" max="2.5" step="0.1" value="${s.sens}" data-s="sens"><span>${s.sens}</span></label>
      <label class="check"><input type="checkbox" data-s="invertY" ${s.invertY ? 'checked' : ''}> Invert vertical look</label>
      <label class="check"><input type="checkbox" data-s="names" ${s.names ? 'checked' : ''}> Show name tags</label>
      <label class="check"><input type="checkbox" data-s="chatBubbles" ${s.chatBubbles ? 'checked' : ''}> Chat bubbles over heads</label>
      <label class="check"><input type="checkbox" data-s="filter" ${s.filter !== false ? 'checked' : ''}> Filter strong language</label>
      <div class="btn-row"><button data-s="avatar" class="ghost">Edit avatar</button></div>`;
    m.querySelector('.body').onchange = m.querySelector('.body').oninput = (e) => {
      const t = e.target, k = t.dataset.s;
      if (!k) return;
      s[k] = t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value;
      if (t.type === 'range') t.parentElement.querySelector('span').textContent = t.value;
      this.g.store.set('settings', s);
      this.g.player.settings.sens = s.sens; this.g.player.settings.invertY = s.invertY;
      if (k === 'quality' && e.type === 'change') { this.g.applyQuality(); this.toast(`Graphics: ${this.g.qualityName}`); }
      if (k === 'volume' || k === 'sound') { this.g.sound.start(); this.g.sound.setVolume(); if (k === 'volume') t.parentElement.querySelector('span').textContent = Math.round(s.volume * 100); }
      if (k === 'adaptive' && !s.adaptive) { this.g.resScale = 1; this.g.renderer.setPixelRatio(this.g.basePixelRatio); this.g.resize(); }
      if (k === 'names') this.g.labels.domElement.style.display = s.names ? '' : 'none';
    };
    m.querySelector('[data-s=avatar]').onclick = () => { m.classList.remove('show'); this.showWelcome(false); };
    m.classList.add('show');
  }

  // ---------------------------------------------------------------- map
  // a shaded relief image of the island coloured by ground type, regenerated when the land changes
  renderMapImage() {
    const S = 256, t = this.g.terrain;
    const c = this.mapImg || Object.assign(document.createElement('canvas'), { width: S, height: S });
    const ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
    const step = (N - 1) / S;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const gi = Math.floor(i * step), gj = Math.floor(j * step), k = gj * N + gi;
      const h = t.h[k];
      let r, g, b;
      if (h < SEA) { const d = Math.min(1, -h / 20); r = 40 - d * 30; g = 120 - d * 70; b = 150 - d * 50; }
      else {
        const w = t.w;
        const gr = w[k * 4] / 255, so = w[k * 4 + 1] / 255, ro = w[k * 4 + 2] / 255, sa = w[k * 4 + 3] / 255;
        r = gr * 92 + so * 98 + ro * 128 + sa * 205; g = gr * 128 + so * 88 + ro * 124 + sa * 188; b = gr * 62 + so * 58 + ro * 118 + sa * 140;
        if (h > 85) { r = g = b = 235; }
        const hx = t.h[gj * N + Math.min(N - 1, gi + 1)] - h, hz = t.h[Math.min(N - 1, gj + 1) * N + gi] - h;
        const shade = THREE.MathUtils.clamp(1 + (-hx - hz) * 0.12, 0.55, 1.35);
        r *= shade; g *= shade; b *= shade;
      }
      const o = (j * S + i) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.mapImg = c;
    this.mapDirty = false;
  }

  drawWorld(ctx, W, H, view) {
    // view: { x, z, span } in metres
    const g = this.g;
    const toPx = (x, z) => [((x - (view.x - view.span / 2)) / view.span) * W, ((z - (view.z - view.span / 2)) / view.span) * H];
    ctx.fillStyle = '#0d2a36'; ctx.fillRect(0, 0, W, H);
    const [ax, az] = toPx(-HALF, -HALF), [bx, bz] = toPx(HALF, HALF);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.mapImg, ax, az, bx - ax, bz - az);
    // plots
    for (const [k, p] of g.plots) {
      const o = plotOrigin(k);
      const [x0, z0] = toPx(o.x, o.z), [x1, z1] = toPx(o.x + PLOT, o.z + PLOT);
      ctx.fillStyle = p.owner === g.me.uid ? 'rgba(89,242,140,0.35)' : p.open ? 'rgba(102,179,255,0.3)' : 'rgba(255,140,89,0.3)';
      ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
    }
    // buildings
    ctx.fillStyle = 'rgba(245,240,230,0.85)';
    const dot = Math.max(1, W / view.span * 1.6);
    for (const r of g.objects.recs.values()) {
      if (r.t === 'cut' || r.t.startsWith('tree:') || r.t.startsWith('m:')) continue;
      const [x, z] = toPx(r.x, r.z);
      if (x < -4 || z < -4 || x > W + 4 || z > H + 4) continue;
      ctx.fillRect(x - dot / 2, z - dot / 2, dot, dot);
    }
    // people
    for (const p of g.players.values()) {
      const [x, z] = toPx(p.pos.x, p.pos.z);
      ctx.fillStyle = this.friends.has(p.uid) ? '#ffd166' : '#ffffff';
      ctx.beginPath(); ctx.arc(x, z, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0008'; ctx.lineWidth = 1; ctx.stroke();
    }
    // me: an arrow pointing where the camera looks
    const [mx, mz] = toPx(g.player.pos.x, g.player.pos.z);
    ctx.save(); ctx.translate(mx, mz); ctx.rotate(-g.player.camYaw + Math.PI);
    ctx.fillStyle = '#5ad1ff'; ctx.strokeStyle = '#002'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5.5, 6); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  openMap() {
    if (!this.g.ready) return;
    const m = $('#map');
    m.classList.add('show');
    if (this.mapDirty || !this.mapImg) this.renderMapImage();
    const c = $('#map-canvas');
    const size = Math.min(innerWidth - 80, innerHeight - 160, 760);
    c.width = c.height = size;
    this.drawWorld(c.getContext('2d'), size, size, { x: 0, z: 0, span: HALF * 2 });
    const labels = $('#map-labels');
    labels.innerHTML = [...this.g.plots.entries()].filter(([, p]) => p.name).map(([k, p]) => {
      const o = plotOrigin(k);
      return `<span style="left:${((o.x + PLOT / 2 + HALF) / (2 * HALF)) * 100}%;top:${((o.z + PLOT / 2 + HALF) / (2 * HALF)) * 100}%">${esc(p.name)}</span>`;
    }).join('');
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    if (!this.g.ready) return;
    this.miniT = (this.miniT || 0) + dt;
    if (this.miniT > (this.g.q.shadowEvery > 1 ? 0.5 : 0.25)) {
      this.miniT = 0;
      if (this.mapDirty && (this.mapAge = (this.mapAge || 0) + 1) > 8) { this.renderMapImage(); this.mapAge = 0; }
      if (!this.mapImg) this.renderMapImage();
      const c = $('#minimap');
      this.drawWorld(c.getContext('2d'), c.width, c.height, { x: this.g.player.pos.x, z: this.g.player.pos.z, span: 360 });
      // clock
      const tod = this.g.timeOfDay();
      const mins = Math.floor(tod * 24 * 60);
      $('#clock').textContent = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      $('#clock').classList.toggle('night', this.g.env.daylight < 0.4);
      const w = this.g.weather;
      if (w) {
        const icon = { clear: this.g.env.daylight < 0.4 ? '☾' : '☀', cloudy: '☁', rain: '🌧', storm: '⛈', fog: '🌫' }[w.kind];
        const pill = $('#weather-pill');
        const txt = `${icon} ${WEATHER[w.kind].label}`;
        if (pill.textContent !== txt) { pill.textContent = txt; const f = w.forecast(this.g.now()); pill.title = `Next: ${WEATHER[f.next].label} in about ${f.minutes} min`; }
      }
      const p = this.g.player.pos;
      const plot = this.g.plotAt(p.x, p.z);
      $('#where').textContent = plot ? (plot.name || 'Private plot') + ` · ${this.g.ownerName(plot.owner)}` : this.g.player.flying ? 'Flying' : this.g.player.mode === 'swim' ? 'Swimming' : 'Public land';
    }
  }

  setFreeCam(on) { document.body.classList.toggle('freecam', on); }

  // ---------------------------------------------------------------- notice board
  openNotices() {
    this.renderNotices();
    $('#notices').classList.add('show');
    setTimeout(() => $('#notice-text').focus(), 50);
  }
  renderNotices() {
    const notes = this.g.notes;
    $('#notice-list').innerHTML = notes.length ? [...notes].reverse().map((n) => `<div class="note"><b style="color:${this.nameColor(n.uid)}">${esc(n.n)}</b><span class="muted"> · ${new Date(n.time).toLocaleDateString()} ${new Date(n.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><p>${esc(this.filterWords(n.text))}</p></div>`).join('') : '<p class="muted">No notes yet. Be the first!</p>';
  }

  // ---------------------------------------------------------------- townspeople
  npcDialog(p, line) {
    const el = $('#npc'), g = this.g;
    el.querySelector('.npc-name').textContent = `${p.def.name} · ${p.def.role}`;
    el.querySelector('.npc-line').textContent = `"${line}"`;
    const acts = p.def.guide
      ? [['tour', 'Show me around'], ['home', 'Find me a free home'], ['weather', 'What\'s the weather?'], ['bye', 'Bye!']]
      : [['more', 'Tell me more'], ['bye', 'Bye!']];
    el.querySelector('.npc-acts').innerHTML = acts.map(([k, l], i) => `<button class="${i ? 'ghost' : ''}" data-n="${k}">${l}</button>`).join('');
    el.querySelector('.npc-acts').onclick = (e) => {
      const b = e.target.closest('[data-n]');
      if (!b) return;
      const k = b.dataset.n;
      if (k === 'bye') { el.classList.remove('show'); p.av.setEmote('wave'); setTimeout(() => p.av.setEmote(null), 2500); return; }
      if (k === 'more') { this.npcDialog(p, g.town.talk(p)); return; }
      if (k === 'tour') { g.quests.show(); el.querySelector('.npc-line').textContent = '"Follow the checklist on the left - I\'ll tick things off as you go!"'; return; }
      if (k === 'home') { el.classList.remove('show'); g.quests.starterHome(); return; }
      if (k === 'weather') { const f = g.weather.forecast(g.now()); el.querySelector('.npc-line').textContent = `"Right now it's ${WEATHER[g.weather.kind].label.toLowerCase()}. In about ${f.minutes} minutes: ${WEATHER[f.next].label.toLowerCase()}."`; }
    };
    el.classList.add('show');
  }

  // ---------------------------------------------------------------- photo mode
  enterPhoto() {
    if (!this.g.ready) return;
    document.body.classList.add('photo');
    this.toast('Photo mode: frame your shot (drag, scroll, V for free camera), then Take photo');
  }
  exitPhoto() { document.body.classList.remove('photo', 'photo-names'); }
  photoFlash() {
    const f = $('#flash');
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }

  hint(text) {
    const el = $('#hint');
    if (el.textContent !== text) el.textContent = text;
    el.style.opacity = text ? 1 : 0;
  }

  toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3800);
  }

  sound(kind) {
    try {
      this.ac = this.ac || new AudioContext();
      const ac = this.ac, o = ac.createOscillator(), gn = ac.createGain();
      const f = { place: [520, 780], remove: [420, 260], chat: [880, 990] }[kind] || [600, 600];
      o.type = kind === 'chat' ? 'sine' : 'triangle';
      o.frequency.setValueAtTime(f[0], ac.currentTime);
      o.frequency.exponentialRampToValueAtTime(f[1], ac.currentTime + 0.08);
      gn.gain.setValueAtTime(0.05, ac.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.18);
      o.connect(gn).connect(ac.destination);
      o.start(); o.stop(ac.currentTime + 0.2);
    } catch { }
  }
}
