"""Tool image library: PNGs (ideally transparent) the expert drags onto the video.

Every upload is decoded and re-encoded with OpenCV, so only real raster images are stored
(no SVG/HTML, no embedded metadata), and large images are scaled down to keep the overlay light.
Images without transparency are accepted as-is.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time

import cv2
import numpy as np

from .config import settings

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_SIDE = 512
_lock = threading.Lock()


class ToolError(ValueError):
    pass


def _index_path():
    return settings.tools_dir / "index.json"


def _load() -> list[dict]:
    p = _index_path()
    return json.loads(p.read_text()) if p.exists() else []


def _save(items: list[dict]):
    settings.tools_dir.mkdir(parents=True, exist_ok=True)
    tmp = _index_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=1))
    tmp.replace(_index_path())


def _public(item: dict) -> dict:
    return item | {"url": f"/tool-images/{item['file']}"}


def list_tools() -> list[dict]:
    return [_public(t) for t in _load()]


def add_tool(data: bytes, name: str) -> dict:
    if not data:
        raise ToolError("Empty file.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ToolError("Image is larger than 5 MB.")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None or img.ndim not in (2, 3):
        raise ToolError("Not a supported image. Use PNG (transparent), WebP, JPEG or GIF.")
    if img.dtype != np.uint8:  # 16-bit PNGs
        img = (img / 257).astype(np.uint8)
    h, w = img.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    ok, png = cv2.imencode(".png", img)
    if not ok:
        raise ToolError("Could not process the image.")
    png = png.tobytes()
    digest = hashlib.sha1(png).hexdigest()[:16]
    h, w = img.shape[:2]
    clean_name = " ".join(name.split())[:40] or "Tool"
    with _lock:
        items = _load()
        existing = next((t for t in items if t["id"] == digest), None)
        if existing:
            return _public(existing)
        settings.tools_dir.mkdir(parents=True, exist_ok=True)
        (settings.tools_dir / f"{digest}.png").write_bytes(png)
        item = {"id": digest, "name": clean_name, "file": f"{digest}.png", "w": w, "h": h,
                "transparent": img.ndim == 3 and img.shape[2] == 4, "created": time.time()}
        items.append(item)
        _save(items)
    return _public(item)


def delete_tool(tool_id: str) -> bool:
    with _lock:
        items = _load()
        keep = [t for t in items if t["id"] != tool_id]
        if len(keep) == len(items):
            return False
        _save(keep)
    # The file stays on disk so marks already placed in a live session keep rendering.
    return True
