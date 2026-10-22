"""Tool uploads: PNG images (ideally transparent) and .glb 3D models the expert drags onto the video.

Nothing is written to disk. process_upload() validates and converts a file; the room hub keeps
the result in memory for that meeting only and drops it when the meeting ends.

Every upload is decoded and re-encoded with OpenCV, so only real raster images are stored
(no SVG/HTML, no embedded metadata), and large images are scaled down to keep the overlay light.
Images without transparency are accepted as-is.
"""
from __future__ import annotations

import hashlib

import cv2
import numpy as np

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_MODEL_BYTES = 15 * 1024 * 1024
MAX_SIDE = 512
MAX_TOOLS_PER_ROOM = 30
MAX_BYTES_PER_ROOM = 60 * 1024 * 1024


class ToolError(ValueError):
    pass


def _is_glb(data: bytes) -> bool:
    """Binary glTF 2.0: magic 'glTF', version 2, declared length == file length."""
    return (len(data) >= 20 and data[:4] == b"glTF"
            and int.from_bytes(data[4:8], "little") == 2
            and int.from_bytes(data[8:12], "little") == len(data))


def _tool(blob: bytes, ext: str, name: str, meta: dict) -> dict:
    return {"id": hashlib.sha1(blob).hexdigest()[:16], "ext": ext,
            "name": " ".join(name.split())[:40] or "Tool", "data": blob} | meta


def process_upload(data: bytes, name: str) -> dict:
    """Validate an upload. Returns {id, ext, name, data, kind, w, h, transparent}."""
    if not data:
        raise ToolError("Empty file.")
    if _is_glb(data):
        if len(data) > MAX_MODEL_BYTES:
            raise ToolError("3D model is larger than 15 MB.")
        return _tool(data, "glb", name, {"kind": "model", "w": 1, "h": 1, "transparent": True})
    if data[:4] == b"glTF":
        raise ToolError("Unsupported 3D file. Export it as binary glTF 2.0 (.glb).")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ToolError("Image is larger than 5 MB.")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None or img.ndim not in (2, 3):
        raise ToolError("Not a supported file. Use a PNG (transparent background), WebP, JPEG, GIF or a .glb 3D model.")
    if img.dtype != np.uint8:  # 16-bit PNGs
        img = (img / 257).astype(np.uint8)
    h, w = img.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    ok, png = cv2.imencode(".png", img)
    if not ok:
        raise ToolError("Could not process the image.")
    h, w = img.shape[:2]
    return _tool(png.tobytes(), "png", name, {
        "kind": "image", "w": w, "h": h, "transparent": img.ndim == 3 and img.shape[2] == 4})
