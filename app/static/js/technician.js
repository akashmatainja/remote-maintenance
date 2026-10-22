import { RoomSocket } from "./room-socket.js";
import { LocalSession } from "./local-webrtc.js";
import { JitsiSession } from "./jitsi-client.js";
import { AnnotationLayer } from "./annotations.js";
import { attachAudio, detachAudio, onAudioBlocked, unlockAudio } from "./audio.js";

const RC = window.RC;
const $ = (sel) => document.querySelector(sel);
const video = $("#local-video");
const stage = $("#stage");

const socket = new RoomSocket(RC);
// The technician sees the expert's marks on their own camera preview.
const layer = new AnnotationLayer({
  stage, video, editable: false,
  filter: (a) => !a.source || a.source === RC.name,
});

socket
  .on("state", (m) => { layer.setAll(m.annotations); (m.media || []).forEach(setMedia); peers(m.peers); })
  .on("media", (m) => setMedia(m))
  .on("ann_add", (m) => layer.upsert(m.ann))
  .on("ann_update", (m) => layer.upsert(m.ann))
  .on("ann_remove", (m) => layer.remove(m.id))
  .on("ann_clear", () => layer.clear())
  .on("track", (m) => layer.applyTrack(m.updates))
  .on("presence", (m) => peers(m.peers))
  .on("guide", (m) => guide(m.action, m.value))
  .on("ended", () => end("The expert ended the session."));

// ---------------------------------------------------------------- expert presence, thumbnail, mic
let experts = [];
const media = new Map();         // expert name -> {cam, mic}
const remoteVideos = new Map();  // participantId -> track (the expert's camera, possibly others)
let pipTrack = null;

function peers(list) {
  experts = list.filter((p) => p.role === "expert").map((p) => p.name);
  $("#expert-name").textContent = experts.length ? `Expert: ${experts.join(", ")}` : "Waiting for expert";
  refreshExpertMedia();
}

function setMedia(m) {
  media.set(m.name, { cam: !!m.cam, mic: !!m.mic });
  refreshExpertMedia();
}

function refreshExpertMedia() {
  const micOff = experts.length > 0 && experts.every((n) => media.has(n) && !media.get(n).mic);
  $("#expert-mic").hidden = !micOff;

  // Thumbnail: the first expert with the camera on whose video track we have.
  let next = null;
  if (session) {
    for (const [pid, t] of remoteVideos) {
      const name = session.nameOf(pid);
      if (experts.includes(name) && media.get(name)?.cam) { next = t; break; }
    }
  }
  const pip = $("#expert-video");
  if (next !== pipTrack) {
    pipTrack?.detach(pip);
    pipTrack = next;
    next?.attach(pip);
  }
  pip.hidden = !next;
}

$("#expert-video").addEventListener("click", (e) => e.currentTarget.classList.toggle("pip-left"));

onAudioBlocked(() => { $("#unlock-audio").hidden = false; });
$("#unlock-audio").addEventListener("click", async () => {
  if (await unlockAudio()) $("#unlock-audio").hidden = true;
});

// ---------------------------------------------------------------- guidance from the PTZ panel
const GUIDE = {
  up: ["\u2191", "Tilt up"], down: ["\u2193", "Tilt down"],
  left: ["\u2190", "Pan left"], right: ["\u2192", "Pan right"],
};
let guideTimer;
function guide(action, value) {
  let arrow = "", text = "";
  if (action === "move" && GUIDE[value]) [arrow, text] = GUIDE[value];
  else if (action === "home") [arrow, text] = ["\u2922", "Step back for a wide view"];
  else if (action === "preset") [arrow, text] = ["\u25CE", `Point the camera at: ${value}`];
  else if (action === "zoom") { applyZoom(Number(value)); return; }
  else return;
  $("#guide").innerHTML = `<div><span class="arrow">${arrow}</span>${text}</div>`;
  $("#guide").classList.add("show");
  navigator.vibrate?.(60);
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => $("#guide").classList.remove("show"), 2200);
}

async function applyZoom(level) {
  const mst = session?.localVideo?.getTrack();
  const caps = mst?.getCapabilities?.();
  if (caps?.zoom) {
    const z = caps.zoom.min + level * (caps.zoom.max - caps.zoom.min);
    try { await mst.applyConstraints({ advanced: [{ zoom: z }] }); return; } catch (_) {}
  }
  // No hardware zoom in this browser: ask the technician instead.
  const [arrow, text] = level > 0.5 ? ["\u2295", "Move closer"] : ["\u2296", "Move back a little"];
  $("#guide").innerHTML = `<div><span class="arrow">${arrow}</span>${text}</div>`;
  $("#guide").classList.add("show");
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => $("#guide").classList.remove("show"), 2200);
}

// ---------------------------------------------------------------- Jitsi
let session;
let facing = "environment";

function showLocal() {
  const t = session.localVideo;
  if (!t) return;
  t.attach(video);
  const s = t.getTrack().getSettings?.() || {};
  socket.send({ type: "meta", width: s.width, height: s.height, fps: Math.round(s.frameRate || 0), zoom: !!t.getTrack().getCapabilities?.().zoom, device: t.getTrack().label });
}

async function start() {
  const q = new URLSearchParams({ room: RC.room, role: "technician", name: RC.name });
  const cfg = await (await fetch(`/api/jitsi-config?${q}`)).json();
  const Session = cfg.backend === "local" ? LocalSession : JitsiSession;
  session = new Session(cfg, RC.name, {
    onRemoteTrack: (t) => {
      if (t.getType() === "audio") return attachAudio(t);
      remoteVideos.set(t.getParticipantId(), t);
      refreshExpertMedia();
    },
    onRemoteTrackRemoved: (t) => {
      if (t.getType() === "audio") return detachAudio(t);
      if (remoteVideos.get(t.getParticipantId()) === t) remoteVideos.delete(t.getParticipantId());
      refreshExpertMedia();
    },
    onParticipants: () => refreshExpertMedia(),
    onFailed: (msg) => { if (!/Camera or microphone/.test(msg)) problem("Call not connected", msg); },
    onJoined: () => { $("#status").textContent = "Live"; },
  });
  await session.start({ audio: true, video: true, facingMode: facing, cameraDeviceId: RC.camera || undefined });
  showLocal();
  fillCameraList();
}

async function fillCameraList() {
  const cams = await session.listCameras();
  const sel = $("#camera");
  sel.innerHTML = cams.map((c, i) => `<option value="${c.deviceId}">${c.label || `Camera ${i + 1}`}</option>`).join("");
  const current = session.localVideo?.getDeviceId?.();
  if (current) sel.value = current;
  sel.hidden = cams.length < 2;
}

$("#camera").addEventListener("change", async (e) => {
  await session.switchCamera({ cameraDeviceId: e.target.value });
  showLocal();
});
$("#flip").addEventListener("click", async () => {
  facing = facing === "environment" ? "user" : "environment";
  await session.switchCamera({ facingMode: facing });
  showLocal();
});
$("#mute").addEventListener("click", async (e) => {
  const muted = await session?.toggleMute();
  e.currentTarget.setAttribute("aria-pressed", String(!!muted));
  e.currentTarget.textContent = muted ? "Unmute" : "Mute";
});
$("#leave").addEventListener("click", () => end("You left the session."));

async function end(message) {
  await session?.leave();
  socket.close();
  document.body.innerHTML = `<div style="color:#fff;display:grid;place-content:center;height:100vh;text-align:center;font-family:sans-serif;padding:24px"><p style="font-size:20px">${message}</p></div>`;
}

function problem(title, body) {
  const box = $("#problem");
  box.innerHTML = `<div><strong>${title}</strong>${body}</div>`;
  box.hidden = false;
  $("#status").textContent = "Not connected";
}

function cameraError(err) {
  const name = err?.name || "";
  if (!window.isSecureContext || !navigator.mediaDevices) {
    const https = `https://${location.hostname}:8443${location.pathname}${location.search}`;
    return problem("Camera needs a secure (https) link",
      `Phones only allow the camera on https pages. Ask the expert to start the app with
       <code>python scripts/run_https.py</code>, then open<br><a href="${https}">${https}</a>`);
  }
  if (name === "NotAllowedError") return problem("Camera access is blocked",
    "Tap the icon left of the address bar, open Permissions, allow Camera and Microphone, then reload.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return problem("No usable camera found",
    "Check that the phone has a camera and no other app is recording, then reload.");
  if (name === "NotReadableError") return problem("Camera is busy",
    "Close other apps using the camera (video calls, camera app), then reload.");
  problem("Could not start the camera", String(err?.message || err));
}

if (!window.isSecureContext || !navigator.mediaDevices) cameraError(null);
else start().catch((e) => { console.error(e); cameraError(e); });
window.addEventListener("beforeunload", () => session?.leave());
