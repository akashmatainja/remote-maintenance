// "local" video backend: direct browser-to-browser WebRTC, signaled through this app's
// /rtc/{room} WebSocket. Same public API as JitsiSession, so expert.js and technician.js
// don't change when you switch VIDEO_BACKEND to jitsi.
//
// For testing only: every participant connects to every other one (mesh), there is no
// bridge, and recording is done in the expert's browser. Use Jitsi for real deployments.

class Track {
  constructor(mst, participantId = null, local = false) {
    this.mst = mst;
    this.pid = participantId;
    this.local = local;
  }
  getType() { return this.mst.kind; }
  getParticipantId() { return this.pid; }
  isLocal() { return this.local; }
  getTrack() { return this.mst; }
  getDeviceId() { return this.mst.getSettings?.().deviceId; }
  attach(el) { el.srcObject = new MediaStream([this.mst]); el.play?.().catch(() => {}); }
  detach(el) { if (el.srcObject?.getTracks().includes(this.mst)) el.srcObject = null; }
  isMuted() { return !this.mst.enabled; }
  async mute() { this.mst.enabled = false; }
  async unmute() { this.mst.enabled = true; }
  async dispose() { this.mst.stop(); }
}

function videoConstraints({ facingMode, cameraDeviceId }) {
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24 } };
  return cameraDeviceId ? { ...base, deviceId: { exact: cameraDeviceId } } : { ...base, facingMode };
}

export class LocalSession {
  constructor(cfg, displayName, hooks = {}) {
    this.cfg = cfg;
    this.displayName = displayName;
    this.hooks = hooks;
    this.localTracks = [];
    this.participants = new Map(); // id -> name
    this.peers = new Map();        // id -> {pc, remote: Track[], pending: [], answered}
    this.prevStats = new Map();
  }

  get localAudio() { return this.localTracks.find((t) => t.getType() === "audio"); }
  get localVideo() { return this.localTracks.find((t) => t.getType() === "video"); }
  nameOf(pid) { return this.participants.get(pid) || pid; }

  async start({ audio = true, video = false, facingMode = "environment", cameraDeviceId } = {}) {
    if (audio || video) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: audio ? { echoCancellation: true, noiseSuppression: true } : false,
          video: video ? videoConstraints({ facingMode, cameraDeviceId }) : false,
        });
        this.localTracks = stream.getTracks().map((t) => new Track(t, null, true));
      } catch (err) {
        const hint = window.isSecureContext ? "" : " This page must be opened over HTTPS (or on localhost) to use the camera.";
        this.hooks.onFailed?.(`Camera or microphone blocked: ${err.message || err.name}.${hint}`);
        throw err;
      }
    }
    this._connectSignaling();
    this._statsTimer = setInterval(() => this._collectStats(), 2000);
  }

  _connectSignaling() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = new URLSearchParams({ role: window.RC?.role || "technician", name: this.displayName });
    this.ws = new WebSocket(`${proto}://${location.host}/rtc/${this.cfg.room}?${q}`);
    this.ws.onmessage = (ev) => this._onSignal(JSON.parse(ev.data));
    this.ws.onclose = () => { if (!this.leaving) this.hooks.onFailed?.("Lost connection to the app server. Reload to rejoin."); };
  }

  _send(to, data) { this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ type: "signal", to, data })); }

  async _onSignal(msg) {
    if (msg.type === "welcome") {
      this.myId = msg.id;
      msg.peers.forEach((p) => this.participants.set(p.id, p.name));
      this._emitParticipants();
      this.hooks.onJoined?.();
      for (const p of msg.peers) await this._call(p.id); // newcomer calls everyone already here
    } else if (msg.type === "joined") {
      this.participants.set(msg.peer.id, msg.peer.name);
      this._emitParticipants();
    } else if (msg.type === "left") {
      this._closePeer(msg.id);
      this.participants.delete(msg.id);
      this._emitParticipants();
    } else if (msg.type === "signal") {
      await this._handle(msg.from, msg.data);
    }
  }

  _emitParticipants() {
    this.hooks.onParticipants?.([...this.participants].map(([id, name]) => ({ id, name })));
  }

  _peer(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: this.cfg.iceServers || [] });
    const peer = { pc, remote: [], pending: [] };
    pc.onicecandidate = (e) => e.candidate && this._send(id, { candidate: e.candidate });
    pc.ontrack = (e) => {
      const t = new Track(e.track, id, false);
      peer.remote.push(t);
      this.hooks.onRemoteTrack?.(t);
      e.track.onended = () => this.hooks.onRemoteTrackRemoved?.(t);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.hooks.onFailed?.("Direct connection failed. On different networks, add a TURN server to LOCAL_ICE_SERVERS.");
    };
    this.peers.set(id, peer);
    return peer;
  }

  async _call(id) {
    const { pc } = this._peer(id);
    const stream = new MediaStream(this.localTracks.map((t) => t.getTrack()));
    this.localTracks.forEach((t) => pc.addTrack(t.getTrack(), stream));
    // Always offer to receive both kinds, so an audio-only expert still gets the video.
    for (const kind of ["audio", "video"]) {
      if (!this.localTracks.some((t) => t.getType() === kind)) pc.addTransceiver(kind, { direction: "recvonly" });
    }
    await pc.setLocalDescription(await pc.createOffer());
    this._send(id, { sdp: pc.localDescription });
  }

  async _handle(from, data) {
    const peer = this._peer(from);
    const { pc } = peer;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === "offer") {
        // Attach local media to the transceivers the offer created.
        const stream = new MediaStream(this.localTracks.map((t) => t.getTrack()));
        for (const t of this.localTracks) {
          const tr = pc.getTransceivers().find((x) => x.receiver.track.kind === t.getType() && !x.sender.track);
          if (tr) { await tr.sender.replaceTrack(t.getTrack()); tr.sender.setStreams?.(stream); tr.direction = "sendrecv"; }
          else pc.addTrack(t.getTrack(), stream);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        this._send(from, { sdp: pc.localDescription });
      }
      this._tuneSenders(pc);
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  }

  // Favour sharp frames over smooth motion: a technician holds the camera on a part,
  // and the expert needs to read labels and see bolt heads.
  async _tuneSenders(pc) {
    for (const s of pc.getSenders()) {
      if (s.track?.kind !== "video") continue;
      const p = s.getParameters();
      if (!p.encodings?.length) continue;
      p.encodings[0].maxBitrate = 2_500_000;
      p.degradationPreference = "maintain-resolution";
      try { await s.setParameters(p); } catch (_) {}
    }
  }

  _closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.remote.forEach((t) => this.hooks.onRemoteTrackRemoved?.(t));
    peer.pc.close();
    this.peers.delete(id);
  }

  // Produces the same shape as Jitsi's LOCAL_STATS_UPDATED so summarizeStats() works unchanged.
  async _collectStats() {
    if (!this.hooks.onStats || !this.peers.size) return;
    const out = { transport: [], bitrate: { download: 0, upload: 0 }, packetLoss: { total: 0 }, resolution: {}, framerate: {} };
    let lostSum = 0, recvSum = 0;
    for (const [id, { pc }] of this.peers) {
      const report = await pc.getStats();
      let pair, bytesIn = 0, bytesOut = 0, lost = 0, recv = 0;
      report.forEach((r) => {
        if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || r.selected)) pair = r;
        if (r.type === "inbound-rtp") {
          bytesIn += r.bytesReceived || 0; lost += r.packetsLost || 0; recv += r.packetsReceived || 0;
          if (r.kind === "video" && r.frameHeight) {
            out.resolution[id] = { 1: { width: r.frameWidth, height: r.frameHeight } };
            out.framerate[id] = { 1: Math.round(r.framesPerSecond || 0) };
          }
        }
        if (r.type === "outbound-rtp") bytesOut += r.bytesSent || 0;
      });
      if (pair) {
        const lc = report.get(pair.localCandidateId), rc = report.get(pair.remoteCandidateId);
        out.transport.push({ p2p: true, localCandidateType: lc?.candidateType, remoteCandidateType: rc?.candidateType });
        if (pair.currentRoundTripTime != null) out.jvbRTT = Math.round(pair.currentRoundTripTime * 1000);
      }
      const now = performance.now(), prev = this.prevStats.get(id);
      if (prev) {
        const sec = (now - prev.t) / 1000;
        out.bitrate.download += Math.round(((bytesIn - prev.bytesIn) * 8) / 1000 / sec);
        out.bitrate.upload += Math.round(((bytesOut - prev.bytesOut) * 8) / 1000 / sec);
        lostSum += lost - prev.lost; recvSum += recv - prev.recv;
      }
      this.prevStats.set(id, { t: now, bytesIn, bytesOut, lost, recv });
    }
    out.packetLoss.total = lostSum + recvSum > 0 ? (100 * lostSum) / (lostSum + recvSum) : 0;
    this.hooks.onStats(out);
  }

  async toggleMute() {
    const a = this.localAudio;
    if (!a) return false;
    if (a.isMuted()) await a.unmute(); else await a.mute();
    return a.isMuted();
  }

  async switchCamera({ facingMode, cameraDeviceId }) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints({ facingMode, cameraDeviceId }) });
    const next = new Track(stream.getVideoTracks()[0], null, true);
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(next.getTrack());
    }
    const prev = this.localVideo;
    if (prev) { prev.dispose(); this.localTracks = this.localTracks.filter((t) => t !== prev); }
    this.localTracks.push(next);
    return next;
  }

  async listCameras() {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  }

  // Records everything the expert receives plus their own mic, saved as a .webm download.
  async startRecording() {
    const tracks = [...this.peers.values()].flatMap((p) => p.remote.map((t) => t.getTrack())).filter((t) => t.readyState === "live");
    const video = tracks.find((t) => t.kind === "video");
    if (!video) throw new Error("Nothing to record yet");
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    [...tracks.filter((t) => t.kind === "audio"), this.localAudio?.getTrack()].filter(Boolean)
      .forEach((t) => ac.createMediaStreamSource(new MediaStream([t])).connect(dest));
    const stream = new MediaStream([video, ...dest.stream.getAudioTracks()]);
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm" });
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.onstop = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(this.chunks, { type: "video/webm" }));
      a.download = `session-${this.cfg.room}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.webm`;
      a.click();
      ac.close();
      this.hooks.onRecording?.("off");
    };
    this.recorder.start(1000);
    this.hooks.onRecording?.("on");
  }

  async stopRecording() { this.recorder?.state === "recording" && this.recorder.stop(); }

  async leave() {
    this.leaving = true;
    clearInterval(this._statsTimer);
    await this.stopRecording();
    for (const id of [...this.peers.keys()]) this._closePeer(id);
    this.localTracks.forEach((t) => t.dispose());
    this.ws?.close();
  }
}
