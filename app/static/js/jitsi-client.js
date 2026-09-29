// Thin wrapper around lib-jitsi-meet (loaded from your own Jitsi server as a global).
// We use the low-level library instead of the iframe API because we need the raw
// <video> element: the annotation canvas sits on top of it, and the expert's browser
// samples frames from it for object tracking.

const J = () => window.JitsiMeetJS;

export class JitsiSession {
  /**
   * @param {object} cfg   from /api/jitsi-config {domain, xmppDomain, mucDomain, room, token}
   * @param {object} hooks onRemoteTrack(track), onRemoteTrackRemoved(track), onParticipants(list),
   *                       onStats(stats), onJoined(), onFailed(reason), onRecording(state)
   */
  constructor(cfg, displayName, hooks = {}) {
    this.cfg = cfg;
    this.displayName = displayName;
    this.hooks = hooks;
    this.localTracks = [];
    this.participants = new Map(); // id -> displayName
    this.recordingSession = null;
  }

  async start({ audio = true, video = false, facingMode = "environment", cameraDeviceId } = {}) {
    if (!J()) throw new Error(`lib-jitsi-meet did not load from https://${this.cfg.domain}/libs/`);
    J().init({ disableAudioLevels: true });
    J().setLogLevel(J().logLevels.ERROR);

    const devices = [];
    if (audio) devices.push("audio");
    if (video) devices.push("video");
    if (devices.length) {
      try {
        this.localTracks = await J().createLocalTracks({
          devices, facingMode, cameraDeviceId, resolution: 1080,
          constraints: { video: { height: { ideal: 1080, max: 1080 }, width: { ideal: 1920 }, frameRate: { ideal: 24 } } },
        });
      } catch (err) {
        this.hooks.onFailed?.(`Camera or microphone blocked: ${err.message || err.name || err}`);
        throw err;
      }
    }
    await this._connect();
  }

  _connect() {
    const { domain, xmppDomain, mucDomain, room, token } = this.cfg;
    const options = {
      hosts: { domain: xmppDomain, muc: mucDomain },
      serviceUrl: `wss://${domain}/xmpp-websocket?room=${room}`,
    };
    return new Promise((resolve, reject) => {
      const ev = J().events.connection;
      const JitsiConnection = J().JitsiConnection;
      this.connection = new JitsiConnection(null, token || null, options);
      this.connection.addEventListener(ev.CONNECTION_ESTABLISHED, () => { this._joinConference(); resolve(); });
      this.connection.addEventListener(ev.CONNECTION_FAILED, (err) => {
        this.hooks.onFailed?.(`Could not reach the Jitsi server (${err}). Check JITSI_* settings and the token.`);
        reject(err);
      });
      this.connection.connect();
    });
  }

  _joinConference() {
    const ev = J().events.conference;
    const conf = (this.conference = this.connection.initJitsiConference(this.cfg.room, {}));

    conf.on(ev.TRACK_ADDED, (t) => { if (!t.isLocal()) this.hooks.onRemoteTrack?.(t); });
    conf.on(ev.TRACK_REMOVED, (t) => { if (!t.isLocal()) this.hooks.onRemoteTrackRemoved?.(t); });
    conf.on(ev.CONFERENCE_JOINED, () => {
      this._raiseQuality();
      this.hooks.onJoined?.();
    });
    conf.on(ev.CONFERENCE_FAILED, (e) => this.hooks.onFailed?.(`Conference failed: ${e}`));
    conf.on(ev.USER_JOINED, (id, user) => { this.participants.set(id, user.getDisplayName() || id); this._emitParticipants(); });
    conf.on(ev.USER_LEFT, (id) => { this.participants.delete(id); this._emitParticipants(); });
    conf.on(ev.DISPLAY_NAME_CHANGED, (id, name) => { this.participants.set(id, name); this._emitParticipants(); });
    if (ev.RECORDER_STATE_CHANGED) {
      conf.on(ev.RECORDER_STATE_CHANGED, (s) => this.hooks.onRecording?.(s.getStatus ? s.getStatus() : s));
    }
    const cq = J().events.connectionQuality;
    conf.on(cq.LOCAL_STATS_UPDATED, (stats) => this.hooks.onStats?.(stats));

    conf.setDisplayName(this.displayName);
    this.localTracks.forEach((t) => conf.addTrack(t));
    conf.join();
  }

  _raiseQuality() {
    // Ask the bridge for full resolution from the technician's camera; the default
    // for small layouts is often 360p, which is too coarse to see a bolt head.
    try { this.conference.setSenderVideoConstraint?.(1080); } catch (_) {}
    try {
      this.conference.setReceiverConstraints?.({ lastN: -1, defaultConstraints: { maxHeight: 1080 } });
    } catch (_) {}
  }

  _emitParticipants() {
    this.hooks.onParticipants?.([...this.participants].map(([id, name]) => ({ id, name })));
  }

  nameOf(participantId) { return this.participants.get(participantId) || participantId; }
  get localAudio() { return this.localTracks.find((t) => t.getType() === "audio"); }
  get localVideo() { return this.localTracks.find((t) => t.getType() === "video"); }

  async toggleMute() {
    const a = this.localAudio;
    if (!a) return false;
    if (a.isMuted()) await a.unmute(); else await a.mute();
    return a.isMuted();
  }

  /** Swap the camera (front/back, or a virtual device fed by an IP camera gateway). */
  async switchCamera({ facingMode, cameraDeviceId }) {
    const [next] = await J().createLocalTracks({
      devices: ["video"], facingMode, cameraDeviceId, resolution: 1080,
      constraints: { video: { height: { ideal: 1080 }, width: { ideal: 1920 }, frameRate: { ideal: 24 } } },
    });
    const prev = this.localVideo;
    if (prev) {
      await this.conference.replaceTrack(prev, next);
      await prev.dispose();
      this.localTracks = this.localTracks.filter((t) => t !== prev);
    } else {
      await this.conference.addTrack(next);
    }
    this.localTracks.push(next);
    return next;
  }

  listCameras() {
    return new Promise((res) => J().mediaDevices.enumerateDevices((list) => res(list.filter((d) => d.kind === "videoinput"))));
  }

  /** Needs Jibri on the Jitsi server. */
  async startRecording() {
    const mode = J().constants?.recording?.mode?.FILE || "file";
    this.recordingSession = await this.conference.startRecording({ mode });
    return this.recordingSession;
  }

  async stopRecording() {
    const id = this.recordingSession?.getID?.() ?? this.recordingSession?.sessionID;
    if (id) await this.conference.stopRecording(id);
    this.recordingSession = null;
  }

  async leave() {
    try { await this.conference?.leave(); } catch (_) {}
    for (const t of this.localTracks) { try { await t.dispose(); } catch (_) {} }
    try { this.connection?.disconnect(); } catch (_) {}
  }
}

/** Turn lib-jitsi-meet LOCAL_STATS_UPDATED into the numbers shown in the stats bar. */
export function summarizeStats(stats, remoteId) {
  const out = {};
  const tr = (stats.transport || [])[0];
  if (tr) {
    const relay = tr.localCandidateType === "relay" || tr.remoteCandidateType === "relay";
    out.connection = relay ? "TURN relay" : tr.p2p ? "Peer-to-peer" : "Direct (bridge)";
  }
  if (typeof stats.jvbRTT === "number") out.rttMs = stats.jvbRTT;
  if (stats.bitrate) {
    const kbps = (stats.bitrate.download || 0) + (stats.bitrate.upload || 0);
    out.bitrate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
  }
  if (stats.packetLoss) out.packetLoss = `${(stats.packetLoss.total ?? 0).toFixed(1)} %`;
  const pick = (m) => {
    const byUser = m && (m[remoteId] || Object.values(m)[0]);
    return byUser ? Object.values(byUser)[0] : undefined;
  };
  const res = pick(stats.resolution);
  if (res?.height) out.resolution = `${res.height}p`;
  const fps = pick(stats.framerate);
  if (fps) out.fps = `${fps} fps`;
  return out;
}
