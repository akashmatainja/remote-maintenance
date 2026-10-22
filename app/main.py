"""Expert Guided Remote Maintenance - FastAPI entry point.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
Browsers need HTTPS (or localhost) for camera access; see README for a reverse-proxy setup.
"""
import secrets
import string
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.responses import HTMLResponse, RedirectResponse
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
settings.tools_dir.mkdir(parents=True, exist_ok=True)
app.mount("/tool-images", StaticFiles(directory=settings.tools_dir), name="tool-images")
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
    room = _clean_room(room)
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
@app.get("/api/tools")
def list_tools():
    return tools.list_tools()


@app.post("/api/tools")
async def upload_tool(request: Request, name: str = ""):
    """Raw image bytes in the body (no multipart), name in the query string."""
    size = int(request.headers.get("content-length") or 0)
    if size > tools.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Image is larger than 5 MB.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > tools.MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Image is larger than 5 MB.")
    try:
        return tools.add_tool(bytes(body), name)
    except tools.ToolError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/tools/{tool_id}")
def delete_tool(tool_id: str):
    if not tools.delete_tool(tool_id):
        raise HTTPException(404, "No such tool.")
    return {"ok": True}


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
