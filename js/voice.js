// Proximity voice chat. Microphones connect directly between players (WebRTC); the world server only
// relays the connection handshake. Each voice is placed in 3D at the speaker's avatar, so people get
// quieter as you walk away and come from the left or right like real voices. Fades out past 45 m.
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const RANGE = 45;

export class Voice {
  constructor(game) {
    this.g = game;
    this.on = false;
    this.muted = false;
    this.local = null;
    this.peers = new Map();   // sid -> { pc, panner, gain, el, analyser, level }
  }

  async enable() {
    if (this.on) return true;
    const g = this.g;
    try {
      this.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      g.ui.toast('Microphone not available or not allowed - check your browser\'s permission', 'warn');
      return false;
    }
    g.sound.start();
    this.ctx = g.sound.ctx;
    // my own level, for the speaking ring on my name tag
    const src = this.ctx.createMediaStreamSource(this.local);
    this.myAnalyser = this.ctx.createAnalyser(); this.myAnalyser.fftSize = 256;
    src.connect(this.myAnalyser);
    this.on = true;
    g.sendState(true);
    g.ui.toast('Voice on - people within 45 m can hear you. Click the mic again to mute.');
    return true;
  }

  disable() {
    if (!this.on) return;
    for (const sid of [...this.peers.keys()]) this.drop(sid);
    for (const tr of this.local.getTracks()) tr.stop();
    this.local = null;
    this.on = false;
    this.g.sendState(true);
  }

  setMuted(m) {
    this.muted = m;
    if (this.local) for (const tr of this.local.getAudioTracks()) tr.enabled = !m;
  }

  send(sid, msg) { this.g.net.send(`V ${sid}\t${JSON.stringify(msg)}`); }

  peer(sid) {
    let p = this.peers.get(sid);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    for (const tr of this.local.getTracks()) pc.addTrack(tr, this.local);
    pc.onicecandidate = (e) => { if (e.candidate) this.send(sid, { ice: e.candidate }); };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      // Chrome only feeds WebAudio from a remote stream that is also attached to a (muted) element
      const el = new Audio(); el.muted = true; el.srcObject = stream; el.play().catch(() => { });
      const ctx = this.ctx;
      const src = ctx.createMediaStreamSource(stream);
      const panner = ctx.createPanner();
      Object.assign(panner, { panningModel: 'HRTF', distanceModel: 'linear', refDistance: 2, maxDistance: RANGE, rolloffFactor: 1 });
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
      src.connect(analyser); src.connect(panner); panner.connect(gain); gain.connect(ctx.destination);
      Object.assign(p, { el, panner, gain, analyser });
    };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) this.drop(sid); };
    p = { pc, level: 0 };
    this.peers.set(sid, p);
    return p;
  }

  drop(sid) {
    const p = this.peers.get(sid);
    if (!p) return;
    try { p.pc.close(); } catch { }
    if (p.gain) p.gain.disconnect();
    this.peers.delete(sid);
  }

  async onSignal(from, msg) {
    if (!this.on) return;
    const p = this.peer(from);
    try {
      if (msg.sdp) {
        await p.pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === 'offer') {
          await p.pc.setLocalDescription(await p.pc.createAnswer());
          this.send(from, { sdp: p.pc.localDescription });
        }
      } else if (msg.ice) await p.pc.addIceCandidate(msg.ice);
    } catch (e) { console.warn('voice signal', e); }
  }

  level(analyser) {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += (v - 128) ** 2;
    return Math.sqrt(s / buf.length) / 128;
  }

  update() {
    const g = this.g;
    if (!this.on) return;
    // connect to voice-enabled players in range (the lower session id makes the offer), drop far ones
    for (const pl of g.players.values()) {
      const near = pl.voice && g.distanceTo(pl.sid) < RANGE + 10;
      const has = this.peers.has(pl.sid);
      if (near && !has && g.me.sid < pl.sid) {
        const p = this.peer(pl.sid);
        p.pc.createOffer().then((o) => p.pc.setLocalDescription(o)).then(() => this.send(pl.sid, { sdp: p.pc.localDescription })).catch(() => { });
      } else if (!near && has && g.distanceTo(pl.sid) > RANGE + 25) this.drop(pl.sid);
    }
    for (const sid of this.peers.keys()) if (!g.players.has(sid)) this.drop(sid);
    // place every voice at its speaker, and the listener at the camera
    const ctx = this.ctx, l = ctx.listener, cam = g.camera;
    const f = cam.getWorldDirection(cam.position.clone().set(0, 0, 0));
    if (l.positionX) {
      l.positionX.value = cam.position.x; l.positionY.value = cam.position.y; l.positionZ.value = cam.position.z;
      l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
    for (const [sid, p] of this.peers) {
      const pl = g.players.get(sid);
      if (!pl || !p.panner) continue;
      if (p.panner.positionX) { p.panner.positionX.value = pl.pos.x; p.panner.positionY.value = pl.pos.y + 1.6; p.panner.positionZ.value = pl.pos.z; }
      p.gain.gain.value = g.ui.muted.has(pl.uid) ? 0 : 1;
      pl.avatar.setSpeaking(this.level(p.analyser) > 0.04);
    }
    g.myAvatar.setSpeaking(!this.muted && this.level(this.myAnalyser) > 0.04);
  }
}
