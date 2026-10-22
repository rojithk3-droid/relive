// Connection to the world server (see server/relive-server.ps1 for the protocol). When no server is
// reachable (opened from disk, or the server is off) a small in-browser stand-in keeps the same protocol
// and saves the world to localStorage, so the game still works solo.

import { WORLD_SERVER } from './config.js';

function token(as) {
  const key = 'rl.token' + (as ? '.' + as : '');
  let t = null;
  try { t = localStorage.getItem(key); } catch { }
  if (!t) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(key, t); } catch { }
  }
  return t;
}

export class Net {
  constructor() {
    this.ws = null;
    this.online = false;
    this.offline = null;
    this.onLine = null;          // (line) for every server line
    this.onStatus = null;        // ('online'|'offline'|'reconnecting')
    this.queue = [];
    this.pending = [];
    this.flushTimer = 0;
    this.as = new URLSearchParams(location.search).get('as') || '';
    this.token = token(this.as);
  }

  // Where the world server lives: ?server=wss://host/ws on the link, else WORLD_SERVER in config.js,
  // else the same host that served the page (the PowerShell server serves both).
  serverUrl() {
    const q = new URLSearchParams(location.search).get('server');
    if (q) return q;
    if (WORLD_SERVER) return WORLD_SERVER;
    if (location.protocol === 'file:') return null;
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  connect(profileJson) {
    this.profileJson = profileJson;
    const url = this.serverUrl();
    if (!url) { this.goOffline(); return; }
    let opened = false;
    try { this.ws = new WebSocket(url); } catch { this.goOffline(); return; }
    // The first seconds of a visit are busy (shaders compiling, the town being built), which can delay
    // the open event past a short timer. Only give up while the socket is still connecting after 15 s.
    const started = performance.now();
    let fail;
    const check = () => {
      if (opened || this.ws.readyState === 1) return;
      if (this.ws.readyState === 0 && performance.now() - started < 15000) { fail = setTimeout(check, 1000); return; }
      try { this.ws.close(); } catch { }
      this.goOffline();
    };
    fail = setTimeout(check, 4000);
    this.ws.onopen = () => {
      opened = true; clearTimeout(fail);
      this.online = true;
      this.ws.send('H ' + this.token + '\t' + this.profileJson);
      for (const l of this.pending) this.ws.send(l);
      this.pending = [];
      this.onStatus && this.onStatus('online');
    };
    this.ws.onmessage = (e) => { for (const line of String(e.data).split('\n')) if (line) this.onLine(line); };
    this.ws.onclose = () => {
      clearTimeout(fail);
      if (!opened) { this.goOffline(); return; }
      this.online = false;
      this.onStatus && this.onStatus('reconnecting');
      setTimeout(() => this.connect(this.profileJson), 2000);
    };
  }

  goOffline() {
    if (this.offline) return;
    this.offline = new LocalWorld(this.token, (line) => this.onLine(line));
    this.onStatus && this.onStatus('offline');
    this.offline.hello(this.profileJson);
  }

  // commands are batched per animation frame (one websocket frame, one line each)
  send(line) {
    if (this.offline) { this.offline.command(line); return; }
    this.queue.push(line);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 0);
  }
  flush() {
    this.flushTimer = 0;
    if (!this.queue.length) return;
    const msg = this.queue.join('\n');
    this.queue = [];
    if (this.online && this.ws.readyState === 1) this.ws.send(msg);
    else if (!msg.startsWith('P ')) this.pending.push(msg);
  }
}

// ------------------------------------------------------------------ solo mode
class LocalWorld {
  constructor(tok, emit) {
    this.emit = emit;
    this.uid = 'solo' + tok.slice(0, 6);
    this.state = { objects: {}, plots: {}, terrain: [], chat: [], epoch: Date.now() };
    try { const s = JSON.parse(localStorage.getItem('rl.offlineWorld') || 'null'); if (s) this.state = s; } catch { }
    this.saveTimer = 0;
  }
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { try { localStorage.setItem('rl.offlineWorld', JSON.stringify(this.state)); } catch { } }, 800);
  }
  hello(profile) {
    const s = this.state, lines = [`Y 1\t${this.uid}\t${Date.now()}\t${s.epoch}`, 'B'];
    for (const [k, p] of Object.entries(s.plots)) lines.push(`L ${k}\t${p.owner}\t${p.open}\t${p.json}`);
    for (const t of s.terrain) lines.push('T ' + t);
    for (const [id, o] of Object.entries(s.objects)) lines.push(`O ${id}\t${o.owner}\t${o.x}\t${o.z}\t${o.json}`);
    for (const c of s.chat) lines.push(c);
    for (const n of s.notes || []) lines.push(n);
    lines.push('B end');
    setTimeout(() => { for (const l of lines) this.emit(l); }, 0);
  }
  command(line) {
    const cmd = line[0], rest = line.slice(2), s = this.state;
    const parts = (n) => { const a = rest.split('\t'); return a.length > n ? [...a.slice(0, n - 1), a.slice(n - 1).join('\t')] : a; };
    switch (cmd) {
      case 'O': { const [id, x, z, json] = parts(4); s.objects[id] = { owner: s.objects[id]?.owner || this.uid, x: +x, z: +z, json }; break; }
      case 'D': delete s.objects[rest.trim()]; break;
      case 'T': s.terrain.push(rest); break;
      case 'L': { const [k, open, json] = parts(3); s.plots[k] = { owner: this.uid, open, json }; this.emit(`L ${k}\t${this.uid}\t${open}\t${json}`); break; }
      case 'R': delete s.plots[rest.trim()]; this.emit('R ' + rest.trim()); break;
      case 'C': { const l = `C 1\t${this.uid}\t${Date.now()}\t${rest}`; s.chat.push(l); if (s.chat.length > 150) s.chat.shift(); this.emit(l); break; }
      case 'W': this.emit('E That player is offline.'); return;
      case 'K': { const l = `K 1\t${this.uid}\t${Date.now()}\t${rest}`; (s.notes ||= []).push(l); if (s.notes.length > 60) s.notes.shift(); this.emit(l); break; }
      default: return;
    }
    this.save();
  }
}
