"""Expert Guided Remote Maintenance - FastAPI entry point.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
Browsers need HTTPS (or localhost) for camera access; see README for a reverse-proxy setup.
"""
import secrets
import string
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import db, ptz, tools
from .config import settings
from .jitsi_auth import make_token
from .realtime import hub
from .signaling import signal_hub

APP_DIR = Path(__file__).parent


@asynccontextmanager
async def lifespan(_app):
    db.init_db()
    yield


app = FastAPI(title="Expert Guided Remote Maintenance", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    """Make browsers check for a newer app file on every load (a cheap 304 when unchanged).

    Without this, phones keep old JavaScript for hours after an update, so new features
    (tool images, expert thumbnail) silently don't appear on the technician's screen.
    """
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"

    return response

templates = Jinja2Templates(directory=APP_DIR / "templates")

ROOM_ALPHABET = "".join(c for c in string.ascii_uppercase + string.digits if c not in "O0I1")
NAV = [
    ("Dashboard", "/"),
    # ("Machines", "/machines"),
    # ("Work Orders", "/work-orders"),
    ("Remote Camera", "/remote-camera"),
    ("Sessions", "/sessions"),
    # ("Reports", "/reports"),
]


def _clean_room(room: str) -> str:
    room = "".join(c for c in room.upper() if c.isalnum())[:16]
    if len(room) < 4:
        raise HTTPException(400, "Room code must be at least 4 letters or digits.")
    return room


def _render(request: Request, template: str, active: str, **ctx):
    return templates.TemplateResponse(
        request, template,
        {"nav": NAV, "active": active, "jitsi_domain": settings.jitsi_domain,
         "video_backend": settings.video_backend, **ctx},
    )


# ---------------------------------------------------------------------------- pages
@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    return _render(request, "join.html", "Dashboard", sessions=db.list_sessions(8))


@app.get("/remote-camera", response_class=HTMLResponse)
def remote_camera(
    request: Request,
    room: str | None = None,
    role: str = Query("expert", pattern="^(expert|technician)$"),
    name: str = "",
):
    if not room:
        return RedirectResponse("/")
    try:
        room = _clean_room(room)
    except HTTPException:
        return _render(request, "join.html", "Dashboard", sessions=db.list_sessions(8),
                       error="That room link isn't valid. Room codes have at least 4 letters or numbers. "
                             "Ask the expert to send the link again.")
    ctx = {"room": room, "role": role, "name": name or ("Expert" if role == "expert" else "Technician"),
           "mode": ptz.camera_mode(room), "presets": ptz.preset_names(room)}
    template = "technician.html" if role == "technician" else "expert.html"
    return _render(request, template, "Remote Camera", **ctx)


@app.get("/sessions", response_class=HTMLResponse)
def sessions_page(request: Request):
    return _render(request, "sessions.html", "Sessions", sessions=db.list_sessions())


@app.get("/sessions/{session_id}", response_class=HTMLResponse)
def session_detail(request: Request, session_id: int):
    return _render(request, "session_detail.html", "Sessions",
                   session_id=session_id, events=db.session_events(session_id))


@app.get("/{page}", response_class=HTMLResponse)
def placeholder(request: Request, page: str):
    match = {href.strip("/"): label for label, href in NAV}
    if page not in match:
        raise HTTPException(404)
    return _render(request, "placeholder.html", match[page], title=match[page])


# ---------------------------------------------------------------------------- API
# ------------------------------------------------------------------ meeting tools (memory only)
def _live_room(room: str):
    r = hub.active_room(_clean_room(room))
    if r is None:
        raise HTTPException(409, "The meeting isn't running. Start or rejoin the session, then add tools.")
    return r


@app.get("/api/rooms/{room}/tools")
def list_room_tools(room: str):
    return _live_room(room).tool_list()


@app.post("/api/rooms/{room}/tools")
async def upload_room_tool(room: str, request: Request, name: str = ""):
    """Raw file bytes in the body. Kept in memory for this meeting only, never written to disk."""
    r = _live_room(room)
    limit = tools.MAX_MODEL_BYTES  # per-type limits are checked in tools.process_upload
    if int(request.headers.get("content-length") or 0) > limit:
        raise HTTPException(413, "File is larger than 15 MB.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(413, "File is larger than 15 MB.")
    try:
        return await hub.add_tool(r, tools.process_upload(bytes(body), name))
    except tools.ToolError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/rooms/{room}/tools/{tool_id}")
async def delete_room_tool(room: str, tool_id: str):
    if not await hub.remove_tool(_live_room(room), tool_id):
        raise HTTPException(404, "That tool isn't in this meeting.")
    return {"ok": True}


@app.get("/room-tools/{room}/{filename}")
def room_tool_file(room: str, filename: str):
    r = hub.active_room(_clean_room(room))
    tool = r and r.tools.get(filename.split(".")[0])
    if not tool:
        raise HTTPException(404, "Not available. Tools are removed when the meeting ends.")
    media = "model/gltf-binary" if tool["ext"] == "glb" else "image/png"
    # private + no-store: nothing is kept in shared or browser caches after the meeting
    return Response(tool["data"], media_type=media, headers={"Cache-Control": "private, no-store"})


@app.get("/api/lan-ip")
def lan_ip():
    """LAN address of this server, so an expert on localhost can share a link a phone can open."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except OSError:
        ip = None
    return {"ip": ip}


@app.post("/api/rooms")
def create_room():
    return {"room": "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))}


@app.get("/api/jitsi-config")
def jitsi_config(room: str, role: str = "technician", name: str = ""):
    room = _clean_room(room)
    if settings.video_backend == "local":
        ice = [u.strip() for u in settings.local_ice_servers.split(",") if u.strip()]
        return {"backend": "local", "room": room, "iceServers": [{"urls": u} for u in ice]}
    return {
        "backend": "jitsi",
        "domain": settings.jitsi_domain,
        "xmppDomain": settings.jitsi_xmpp_domain,
        "mucDomain": settings.jitsi_muc_domain,
        "room": room.lower(),
        "token": make_token(room, name or role, role),
    }


@app.websocket("/ws/{room}")
async def room_socket(ws: WebSocket, room: str, role: str = "technician", name: str = ""):
    try:
        room = _clean_room(room)
    except HTTPException:
        await ws.close(code=4400)
        return
    await hub.serve(ws, room, role, name)


@app.websocket("/rtc/{room}")
async def rtc_signaling(ws: WebSocket, room: str, role: str = "technician", name: str = ""):
    """Signaling for VIDEO_BACKEND=local only."""
    try:
        room = _clean_room(room)
    except HTTPException:
        await ws.close(code=4400)
        return
    await signal_hub.serve(ws, room, role, name)
