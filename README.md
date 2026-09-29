# Expert Guided Remote Maintenance

A Python (FastAPI) web app where a remote expert watches a technician's camera through your
self-hosted Jitsi Meet server and marks up the live video: circles, boxes, arrows with labels,
text notes and freehand. Marks can **follow the object** they point at, so an arrow on a
coupling bolt stays on the bolt when the technician's hand moves or the PTZ camera pans.

```
 Technician (phone / PTZ gateway)            Your servers                         Expert (desktop)
 ┌──────────────────────────┐   WebRTC   ┌──────────────────────┐   WebRTC   ┌─────────────────────────┐
 │ camera + mic ────────────┼──────────▶ │  Jitsi (self-hosted) │ ─────────▶ │ <video> + canvas overlay│
 │ sees marks on own preview│            └──────────────────────┘            │ draws marks             │
 │ gets "pan left" prompts  │                                                │ sends 480px JPEG frames │
 └────────────▲─────────────┘            ┌──────────────────────┐            │ ~10 fps while tracking  │
              │   marks, anchor updates  │ FastAPI (this app)   │  frames,   └────────────┬────────────┘
              └──────── WebSocket ───────┤ - room hub           │◀─ marks ────────────────┘
                                         │ - OpenCV CSRT tracker│── anchor updates ──▶
                                         │ - ONVIF PTZ          │── pan/tilt/zoom ──▶ IP camera
                                         │ - SQLite session log │
                                         └──────────────────────┘
```

## How object tracking works

Every mark has an *anchor box* around the object. When the expert draws, the browser snapshots
the frame at that moment and the server starts an OpenCV CSRT tracker on it. While any mark is
set to follow, the expert's browser sends small JPEG frames (about 480 px wide, up to 10/s,
never more than one in flight). The server moves each anchor and broadcasts it; both browsers
redraw the mark relative to its anchor, with smoothing between updates.

If the tracker loses the object (it left the frame, heavy blur), the mark fades and the expert
sees "Lost: drag to re-attach". Use the **Move** tool to drop it back onto the part; tracking
restarts from that frame. Untick **Follow object** to place marks that stay fixed on screen.

Limits worth knowing:
- The technician sees marks slightly behind their own live preview (network delay + about
  50 ms tracking), usually 150–400 ms. Fine for "this bolt", not for fast motion.
- Tracking pauses while the expert's tab is hidden (browsers throttle background tabs).
- CSRT handles moderate scale change and rotation. Big viewpoint changes lose it; re-attach.
- Frames go to *your* FastAPI server only, never to a third party.

## Requirements

- Python 3.10+
- A self-hosted Jitsi Meet server with XMPP WebSocket enabled (default on current installs)
- HTTPS for this app (browsers only allow cameras on HTTPS or localhost)
- Optional: Jibri on the Jitsi server for the **Record** button
- Optional: ONVIF-capable PTZ IP camera

## Quick start: local testing (no Jitsi needed)

`VIDEO_BACKEND=local` (the default) connects the expert and technician browsers directly
with WebRTC, using this app for signaling. Annotations, tracking, PTZ guidance, stats and
sessions work exactly as with Jitsi. Recording saves a `.webm` file in the expert's browser.

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**One computer:** open `http://localhost:8000`, start a session as expert, then open the
technician link in a *separate browser window* placed side by side (not a tab: a hidden tab
pauses tracking). Both will use the same webcam; point it at a real object, since a textured
object tracks much better than a blank wall.

**Phone as the technician (same Wi-Fi):** phones only allow the camera on `https://` pages.
Over `http://192.168.x.x:8000` the camera is blocked without any prompt. Run:

```bash
python scripts/run_https.py
```

It creates a self-signed certificate for your PC's LAN IP (first run only) and prints the
links. Open `https://localhost:8443` on the PC and the printed `https://192.168.x.x:8443`
link on the phone. The phone warns once: tap **Advanced**, then **Proceed**, then allow camera
and microphone. If your PC's IP changes, run it with `--new-cert`. If Windows Firewall asks,
allow Python on private networks.

On the same network the default STUN server is enough (even with no internet, direct LAN
addresses work). Across different networks, add a TURN server to `LOCAL_ICE_SERVERS`.

**Moving to your Jitsi server later:** set `VIDEO_BACKEND=jitsi` and the `JITSI_*` values in
`.env`, then restart. Nothing else changes. The public meet.jit.si can't be used for this app:
it only allows the iframe embed (which hides the video from the overlay and tracker), caps
embedded calls at 5 minutes and requires a moderator login.

## Setup with your own Jitsi server

```bash
cp .env.example .env            # set VIDEO_BACKEND=jitsi, your Jitsi hostnames and JWT secret
cp cameras.example.json cameras.json   # only if you have PTZ cameras
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open `https://your-app/`, start a session as the expert, then use **Copy technician link** and
send it to the technician's phone.

> Run a **single worker**. Room state (marks, trackers) lives in memory. For several app
> servers, pin each room to one server (e.g. hash the room code at the load balancer).

### Jitsi server settings

1. **Domains.** Set `JITSI_DOMAIN`, `JITSI_XMPP_DOMAIN` and `JITSI_MUC_DOMAIN` in `.env`.
   Package installs use `meet.example.com` / `conference.meet.example.com`; docker-jitsi-meet
   uses `meet.jitsi` / `muc.meet.jitsi` internally even when your public name differs.
2. **JWT auth** (recommended so random people can't join rooms):
   - Debian/Ubuntu: `apt install jitsi-meet-tokens`, enter the same app ID and secret.
   - Docker: `ENABLE_AUTH=1`, `AUTH_TYPE=jwt`, `JWT_APP_ID`, `JWT_APP_SECRET`.
   The expert gets moderator rights and recording permission in the token.
3. **Cross-origin WebSocket.** This app loads `lib-jitsi-meet` from your Jitsi server and opens
   `wss://JITSI_DOMAIN/xmpp-websocket` from the app's own origin. If the app is on a different
   hostname, allow it in Prosody (`/etc/prosody/conf.avail/<domain>.cfg.lua`):
   ```lua
   cross_domain_websocket = { "https://maintenance.example.com" }
   ```
   then `systemctl restart prosody`. (Docker: `XMPP_CROSS_DOMAIN=https://maintenance.example.com`.)
4. **Recording:** install and register Jibri. Without it the Record button shows a message.

### Reverse proxy (nginx)

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /ws/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

## Cameras: handheld and PTZ

**Handheld (phone/tablet).** The technician opens the link; the back camera is used by default.
The expert's PTZ buttons become big on-screen prompts on the phone ("Pan left", "Point the
camera at: Gearbox") with a short vibration. The zoom slider drives the phone's hardware zoom
where the browser supports it (Chrome on Android), otherwise it asks the technician to move closer.

**Fixed PTZ IP camera.** Two parts:

1. *Control:* add the room to `cameras.json` (host, credentials, preset tokens). The PTZ panel
   then sends ONVIF moves, zoom and presets straight to the camera. The app server must be able
   to reach the camera on the plant network.
2. *Video into Jitsi:* run a small gateway PC on site that turns the RTSP stream into a webcam
   and joins the room like a technician:
   ```bash
   sudo apt install v4l2loopback-dkms ffmpeg
   sudo modprobe v4l2loopback video_nr=10 card_label="PTZ-7K42QX" exclusive_caps=1
   ffmpeg -rtsp_transport tcp -i "rtsp://user:pass@192.168.1.64:554/Streaming/Channels/101" \
          -vf scale=1920:1080 -pix_fmt yuv420p -f v4l2 /dev/video10
   chromium --use-fake-ui-for-media-stream \
     "https://maintenance.example.com/remote-camera?room=7K42QX&role=technician&name=PTZ%20Camera"
   ```
   Pick "PTZ-7K42QX" in the camera list on that page.

**Both in one room.** When a handheld and a PTZ gateway are in the same room, a **Camera**
selector appears in the expert's toolbar. Marks belong to the camera they were drawn on
(matched by participant name), so each technician only sees marks on their own view.
In a room listed in `cameras.json`, PTZ buttons drive the IP camera rather than prompting the phone.

## Tuning

| Setting | Where | Effect |
|---|---|---|
| `TRACKER_ALGO=csrt\|kcf\|mil` | `.env` | CSRT is most accurate; KCF is ~3x faster on weak CPUs |
| `TRACKER_LOST_FRAMES` | `.env` | Frames without a match before a mark is shown as lost |
| `width`, `fps` | `FrameSampler` in `expert.js` | Tracking frame size and rate (default 480 px, 10/s) |
| `SMOOTH` | `annotations.js` | How quickly marks glide to new positions |

CPU: one CSRT tracker at 480 px costs roughly 5–15 ms per frame. A 4-core server comfortably
handles about 20 concurrent rooms with a few tracked marks each.

## Project layout

```
app/
  main.py          routes, video config endpoint, WebSocket entries
  signaling.py     WebRTC signaling for VIDEO_BACKEND=local
  realtime.py      room hub: marks, presence, PTZ/guidance, frame routing
  tracking.py      OpenCV trackers per room
  ptz.py           ONVIF pan/tilt/zoom/presets
  jitsi_auth.py    JWT for Jitsi token auth
  db.py            SQLite session + event log (Sessions page)
  templates/       expert page, technician page, dashboard, sessions
  static/js/
    jitsi-client.js    lib-jitsi-meet wrapper and stats
    local-webrtc.js    peer-to-peer backend for testing (same API as the Jitsi wrapper)
    annotations.js     overlay canvas, drawing tools, anchor-relative rendering
    frame-sampler.js   frames to the tracker
    expert.js / technician.js
tests/test_tracking_ws.py   end-to-end: a mark follows a moving object over the WebSocket
```

Run the tests with `pytest -q`.

## Next steps you may want

- Freeze-frame mode: pause on a still image, annotate in detail, then return to live.
- Snapshots of annotated frames attached to the work order (the canvas and a video frame
  can be composited in `annotations.js` and POSTed to a new endpoint).
- Real data for Machines / Work Orders / Reports (placeholders now), or a CMMS integration.
