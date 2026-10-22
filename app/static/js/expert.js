import { RoomSocket } from "./room-socket.js";
import { LocalSession } from "./local-webrtc.js";
import { JitsiSession, summarizeStats } from "./jitsi-client.js";
import { AnnotationLayer } from "./annotations.js";
import { FrameSampler } from "./frame-sampler.js";
import { attachAudio, detachAudio, onAudioBlocked, unlockAudio } from "./audio.js";

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
    onMediaError: () => setMicUi(),
    onRemoteTrack: (t) => {
      if (t.getType() === "audio") return attachAudio(t);
      if (expertNames.includes(session.nameOf(t.getParticipantId()))) return; // another expert's camera
      remoteVideos.set(t.getParticipantId(), t);
      refreshSourceList();
      if (!currentPid || !remoteVideos.has(currentPid)) setSource(t.getParticipantId());
    },
    onRemoteTrackRemoved: (t) => {
      if (t.getType() === "audio") return detachAudio(t);
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
  // optional: join even without a working mic, so the expert can still watch and guide.
  await session.start({ audio: true, video: false, optional: true });
  setMicUi();
  sendMedia();
}

// ---------------------------------------------------------------- expert mic + camera
function sendMedia() {
  const a = session?.localAudio;
  socket.send({ type: "media", cam: !!session?.localVideo, mic: !!a && !a.isMuted() });
}
socket.on("open", () => sendMedia()); // the server forgets media state when the socket drops

function setMicUi() {
  const btn = $("#mute"), a = session?.localAudio;
  btn.setAttribute("aria-pressed", String(!a || a.isMuted()));
  btn.textContent = !a ? "Enable mic" : a.isMuted() ? "Unmute" : "Mute";
  btn.title = !a ? "Microphone is off or blocked. Click to allow it." : "";
}

onAudioBlocked(() => toast("Click anywhere on the page to hear the technician"));
document.addEventListener("click", () => unlockAudio(), { once: true });

if (!window.isSecureContext) {
  $("#stage-empty").innerHTML = `<div><strong>Microphone needs a secure (https) link</strong>
    Open this page via https://localhost or start the app with python scripts/run_https.py.</div>`;
} else startCall().catch((e) => console.error(e));

$("#mute").addEventListener("click", async () => {
  if (!session) return;
  try {
    if (!session.localAudio) { await session.enableMic(); toast("Microphone on"); }
    else await session.toggleMute();
  } catch (err) {
    toast(err?.name === "NotAllowedError"
      ? "Microphone is blocked. Allow it from the icon left of the address bar, then click again."
      : `No microphone found (${err?.message || err?.name || err}).`);
  }
  setMicUi();
  sendMedia();
});

$("#cam").addEventListener("click", async (e) => {
  if (!session) return;
  const btn = e.currentTarget, turnOn = !session.localVideo;
  try {
    const t = await session.setCamera(turnOn);
    if (t) t.attach($("#self-view"));
    $("#self-view-wrap").hidden = !t;
    btn.setAttribute("aria-pressed", String(!!t));
    btn.textContent = t ? "Camera off" : "Camera";
  } catch (err) {
    toast(err?.name === "NotAllowedError"
      ? "Camera is blocked. Allow it from the icon left of the address bar, then click again."
      : `Could not start the camera (${err?.message || err?.name || err}).`);
  }
  sendMedia();
});

// ---------------------------------------------------------------- tool images
async function loadTools() {
  const list = await (await fetch("/api/tools")).json();
  const box = $("#tool-items");
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = `<span class="muted">No tool images yet. Upload a PNG with a transparent background.</span>`; return; }
  for (const tool of list) {
    const item = document.createElement("div");
    item.className = "tool-item";
    item.innerHTML = `<button class="tool-place" draggable="true" title="Drag onto the video, or click to place"><img alt=""><span></span></button><button class="tool-del" aria-label="Delete">&times;</button>`;
    const place = item.querySelector(".tool-place"), img = item.querySelector("img");
    img.src = tool.url;
    item.querySelector("span").textContent = tool.name;
    item.querySelector(".tool-del").setAttribute("aria-label", `Delete ${tool.name}`);
    const payload = JSON.stringify({ url: tool.url, name: tool.name, w: tool.w, h: tool.h });
    place.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("application/x-tool", payload);
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
    });
    place.addEventListener("click", () => {
      if (!video.srcObject) return toast("Wait for the technician's video first");
      layer.addImageAt(JSON.parse(payload));
    });
    item.querySelector(".tool-del").addEventListener("click", async () => {
      if (!confirm(`Remove "${tool.name}" from the tool library?`)) return;
      await fetch(`/api/tools/${tool.id}`, { method: "DELETE" });
      loadTools();
    });
    box.appendChild(item);
  }
}

$("#tool-upload").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const file of files) {
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
    const res = await fetch(`/api/tools?${new URLSearchParams({ name })}`, {
      method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(`${file.name}: ${data.detail || "upload failed"}`); continue; }
    if (!data.transparent) toast(`${data.name} has no transparent background. A transparent PNG looks cleaner on video.`);
  }
  loadTools();
});
loadTools();
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

let expertNames = [];
function updatePeers(peers) {
  expertNames = peers.filter((p) => p.role === "expert").map((p) => p.name);
  const techs = peers.filter((p) => p.role === "technician").map((p) => p.name);
  if (!layer.source) $("#cap-tech").textContent = techs.length ? `Technician: ${techs.join(", ")}` : "Technician: waiting";
}
function updateMeta(m) {
  if (m.height) $("#cap-quality").textContent = `${m.height}p${m.fps ? ` \u00B7 ${m.fps} fps` : ""}`;
}
window.addEventListener("beforeunload", () => session?.leave());
