import { RoomSocket } from "./room-socket.js";
import { LocalSession } from "./local-webrtc.js";
import { JitsiSession, summarizeStats } from "./jitsi-client.js";
import { AnnotationLayer } from "./annotations.js";
import { FrameSampler } from "./frame-sampler.js";

const RC = window.RC; // {room, role, name, mode, presets}
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const stage = $("#stage");
const video = $("#remote-video");
const toastEl = $("#toast");
let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

// ---------------------------------------------------------------- realtime + overlay
const socket = new RoomSocket(RC);
const sampler = new FrameSampler(video, socket);
let snapshotPromise = null;

const layer = new AnnotationLayer({
  stage, video, editable: true,
  filter: (a) => !a.source || !layer.source || a.source === layer.source,
  onSnapshotMoment: () => { snapshotPromise = sampler.snapshot(); },
  onCommit: (action, ann) => {
    if (action === "remove") return socket.send({ type: "ann_remove", id: ann.id });
    socket.send({ type: action === "add" ? "ann_add" : "ann_update", ann: AnnotationLayer.serialize(ann) });
    if (ann.tracked && snapshotPromise) snapshotPromise.then((jpeg) => sampler.sendInit(jpeg));
    snapshotPromise = null;
  },
});
sampler.wanted = () => layer.hasTracked() && !!video.srcObject;

socket
  .on("state", (m) => { layer.setAll(m.annotations); updatePeers(m.peers); if (m.meta) updateMeta(m.meta); })
  .on("ann_add", (m) => layer.upsert(m.ann))
  .on("ann_update", (m) => layer.upsert(m.ann))
  .on("ann_remove", (m) => layer.remove(m.id))
  .on("ann_clear", () => layer.clear())
  .on("track", (m) => layer.applyTrack(m.updates))
  .on("presence", (m) => updatePeers(m.peers))
  .on("meta", (m) => updateMeta(m))
  .on("ptz_result", (m) => { if (!m.ok) toast(`Camera did not respond: ${m.error}`); else if (m.guided) toast("Sent to technician"); })
  .on("close", () => $("#stat-room").textContent = `${RC.room} (reconnecting)`)
  .on("open", () => $("#stat-room").textContent = RC.room);

// ---------------------------------------------------------------- toolbar
$$("[data-tool]").forEach((b) => b.addEventListener("click", () => {
  $$("[data-tool]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  layer.setTool(b.dataset.tool);
}));
$$("[data-color]").forEach((b) => b.addEventListener("click", () => {
  $$("[data-color]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  layer.color = b.dataset.color;
}));
$("#follow").addEventListener("change", (e) => { layer.tracked = e.target.checked; });
$("#undo").addEventListener("click", undo);
$("#clear").addEventListener("click", () => { layer.clear(); socket.send({ type: "ann_clear" }); });
function undo() { const id = layer.undoLast(); if (id) socket.send({ type: "ann_remove", id }); }
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !layer.labelInput) { e.preventDefault(); undo(); }
});

// ---------------------------------------------------------------- PTZ / guidance
const ptz = (action, value) => socket.send({ type: "ptz", action, value });
$$("[data-move]").forEach((b) => b.addEventListener("click", () => ptz("move", b.dataset.move)));
$("#ptz-home").addEventListener("click", () => ptz("home"));
$("#zoom").addEventListener("change", (e) => ptz("zoom", Number(e.target.value) / 100));
$$("[data-preset]").forEach((b) => b.addEventListener("click", () => ptz("preset", b.dataset.preset)));

// ---------------------------------------------------------------- Jitsi
const remoteVideos = new Map(); // participantId -> JitsiRemoteTrack
let currentPid = null;
let session;

function setSource(pid) {
  const prev = remoteVideos.get(currentPid);
  if (prev) prev.detach(video);
  currentPid = pid;
  const track = remoteVideos.get(pid);
  $("#stage-empty").hidden = !!track;
  if (!track) { video.srcObject = null; layer.source = ""; return; }
  track.attach(video);
  layer.source = session.nameOf(pid);
  $("#cap-tech").textContent = `Technician: ${layer.source}`;
  $("#source").value = pid;
}

function refreshSourceList() {
  const sel = $("#source");
  sel.innerHTML = "";
  for (const pid of remoteVideos.keys()) {
    const o = document.createElement("option");
    o.value = pid; o.textContent = session.nameOf(pid);
    sel.appendChild(o);
  }
  sel.closest(".group").hidden = remoteVideos.size < 2;
  if (currentPid) sel.value = currentPid;
}
$("#source").addEventListener("change", (e) => setSource(e.target.value));

let startedAt = null;
setInterval(() => {
  if (!startedAt) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $("#timer").textContent = [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");
}, 1000);

async function startCall() {
  const q = new URLSearchParams({ room: RC.room, role: "expert", name: RC.name });
  const cfg = await (await fetch(`/api/jitsi-config?${q}`)).json();
  const Session = cfg.backend === "local" ? LocalSession : JitsiSession;
  session = new Session(cfg, RC.name, {
    onJoined: () => {
      startedAt = Date.now();
      $("#live").classList.remove("idle");
      $("#live").textContent = "\u25CF LIVE";
    },
    onFailed: (msg) => { $("#stage-empty").hidden = false; $("#stage-empty").innerHTML = `<div><strong>Call not connected</strong>${msg}</div>`; },
    onRemoteTrack: (t) => {
      if (t.getType() === "audio") {
        const el = document.createElement("audio");
        el.autoplay = true; el.dataset.pid = t.getParticipantId();
        document.body.appendChild(el);
        t.attach(el);
        return;
      }
      remoteVideos.set(t.getParticipantId(), t);
      refreshSourceList();
      if (!currentPid || !remoteVideos.has(currentPid)) setSource(t.getParticipantId());
    },
    onRemoteTrackRemoved: (t) => {
      if (t.getType() === "audio") { document.querySelectorAll(`audio[data-pid="${t.getParticipantId()}"]`).forEach((e) => e.remove()); return; }
      if (remoteVideos.get(t.getParticipantId()) !== t) return;
      remoteVideos.delete(t.getParticipantId());
      refreshSourceList();
      if (currentPid === t.getParticipantId()) setSource(remoteVideos.keys().next().value || null);
    },
    onParticipants: () => refreshSourceList(),
    onStats: (stats) => {
      const s = summarizeStats(stats, currentPid);
      if (s.connection) $("#stat-conn").textContent = s.connection;
      const rtt = s.rttMs ?? socket.rtt;
      if (rtt != null) $("#stat-latency").textContent = `${Math.round(rtt)} ms`;
      if (s.bitrate) $("#stat-bitrate").textContent = s.bitrate;
      if (s.packetLoss) $("#stat-loss").textContent = s.packetLoss;
      const res = s.resolution || (video.videoHeight ? `${video.videoHeight}p` : null);
      if (res) $("#cap-quality").textContent = [res, s.fps].filter(Boolean).join(" \u00B7 ");
    },
    onRecording: (status) => {
      const on = status === "on";
      $("#record").setAttribute("aria-pressed", String(on));
      $("#live").classList.toggle("rec", on);
    },
  });
  await session.start({ audio: true, video: false });
}

if (!window.isSecureContext) {
  $("#stage-empty").innerHTML = `<div><strong>Microphone needs a secure (https) link</strong>
    Open this page via https://localhost or start the app with python scripts/run_https.py.</div>`;
} else startCall().catch((e) => console.error(e));

$("#mute").addEventListener("click", async (e) => {
  const muted = await session?.toggleMute();
  e.currentTarget.setAttribute("aria-pressed", String(!!muted));
  e.currentTarget.textContent = muted ? "Unmute" : "Mute";
});
$("#record").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    if (btn.getAttribute("aria-pressed") === "true") { await session.stopRecording(); toast("Recording stopped and saved"); }
    else { await session.startRecording(); toast("Recording started"); }
  } catch (err) {
    toast(err.message === "Nothing to record yet" ? "Nothing to record yet: wait for the technician's video."
      : "Recording is unavailable. Install Jibri on the Jitsi server to enable it.");
  }
});
$("#end").addEventListener("click", async () => {
  if (!confirm("End this session for everyone?")) return;
  socket.send({ type: "end" });
  await session?.leave();
  socket.close();
  location.href = "/sessions";
});
$("#copy-link").addEventListener("click", async () => {
  let origin = location.origin;
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    const { ip } = await (await fetch("/api/lan-ip")).json().catch(() => ({}));
    if (ip) origin = `${location.protocol}//${ip}${location.port ? ":" + location.port : ""}`;
  }
  const link = `${origin}/remote-camera?room=${RC.room}&role=technician`;
  try { await navigator.clipboard.writeText(link); toast("Technician link copied"); }
  catch { prompt("Send this link to the technician:", link); }
});

function updatePeers(peers) {
  const techs = peers.filter((p) => p.role === "technician").map((p) => p.name);
  if (!layer.source) $("#cap-tech").textContent = techs.length ? `Technician: ${techs.join(", ")}` : "Technician: waiting";
}
function updateMeta(m) {
  if (m.height) $("#cap-quality").textContent = `${m.height}p${m.fps ? ` \u00B7 ${m.fps} fps` : ""}`;
}
window.addEventListener("beforeunload", () => session?.leave());
