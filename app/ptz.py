"""ONVIF PTZ control for fixed IP cameras.

Rooms listed in cameras.json get real pan/tilt/zoom. For handheld (phone/tablet) rooms the
same PTZ buttons are forwarded to the technician as on-screen guidance instead, and the
zoom slider drives the phone's camera zoom where the browser supports it (see realtime.py).
"""
from __future__ import annotations

import logging
import time
from functools import lru_cache

from .config import load_cameras

log = logging.getLogger("ptz")

MOVES = {
    "up": (0.0, 0.5),
    "down": (0.0, -0.5),
    "left": (-0.5, 0.0),
    "right": (0.5, 0.0),
}
NUDGE_SECONDS = 0.35


class PTZError(RuntimeError):
    pass


class OnvifPTZ:
    def __init__(self, cfg: dict):
        try:
            from onvif import ONVIFCamera
        except ImportError as exc:
            raise PTZError("onvif-zeep is not installed (pip install onvif-zeep)") from exc
        self.cfg = cfg
        cam = ONVIFCamera(cfg["host"], int(cfg.get("port", 80)), cfg["user"], cfg["password"])
        self.media = cam.create_media_service()
        self.ptz = cam.create_ptz_service()
        self.token = self.media.GetProfiles()[0].token
        self.presets = cfg.get("presets", {})

    def nudge(self, direction: str):
        if direction not in MOVES:
            raise PTZError(f"unknown direction {direction!r}")
        x, y = MOVES[direction]
        req = self.ptz.create_type("ContinuousMove")
        req.ProfileToken = self.token
        req.Velocity = {"PanTilt": {"x": x, "y": y}}
        self.ptz.ContinuousMove(req)
        time.sleep(NUDGE_SECONDS)
        self.ptz.Stop({"ProfileToken": self.token, "PanTilt": True, "Zoom": True})

    def home(self):
        self.ptz.GotoHomePosition({"ProfileToken": self.token})

    def zoom(self, level: float):
        """level: 0.0 (wide) .. 1.0 (tele)."""
        level = min(max(level, 0.0), 1.0)
        status = self.ptz.GetStatus({"ProfileToken": self.token})
        req = self.ptz.create_type("AbsoluteMove")
        req.ProfileToken = self.token
        pan_tilt = getattr(getattr(status, "Position", None), "PanTilt", None)
        req.Position = {"Zoom": {"x": level}}
        if pan_tilt is not None:  # some cameras reject a zoom-only AbsoluteMove
            req.Position["PanTilt"] = {"x": pan_tilt.x, "y": pan_tilt.y}
        self.ptz.AbsoluteMove(req)

    def preset(self, name: str):
        token = self.presets.get(name)
        if token is None:
            raise PTZError(f"preset {name!r} is not configured for this camera")
        self.ptz.GotoPreset({"ProfileToken": self.token, "PresetToken": str(token)})


@lru_cache(maxsize=32)
def _camera(room: str) -> OnvifPTZ:
    cfg = load_cameras().get(room.upper())
    if not cfg:
        raise PTZError("no PTZ camera configured for this room")
    return OnvifPTZ(cfg)


def camera_mode(room: str) -> str:
    return "ptz" if room.upper() in load_cameras() else "handheld"


def preset_names(room: str) -> list[str]:
    cfg = load_cameras().get(room.upper())
    return list(cfg.get("presets", {}).keys()) if cfg else []


def execute(room: str, action: str, value=None):
    """Blocking. Call through asyncio.to_thread."""
    cam = _camera(room)
    if action == "move":
        cam.nudge(value)
    elif action == "home":
        cam.home()
    elif action == "zoom":
        cam.zoom(float(value))
    elif action == "preset":
        cam.preset(value)
    else:
        raise PTZError(f"unknown PTZ action {action!r}")
