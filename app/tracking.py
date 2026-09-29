"""Server-side object tracking for annotations.

How it works
------------
The expert's browser grabs small JPEG snapshots (about 480 px wide) of the technician's
video and streams them over the room WebSocket, roughly 10 per second, only while at
least one annotation is set to "follow object".

Each tracked annotation has an *anchor box* around the object it points at. We run one
OpenCV tracker (CSRT by default) per anchor. On every frame the new anchor boxes are
broadcast to everyone in the room, and each browser re-draws the annotation relative
to its anchor, so arrows, circles and labels move with the object.

All boxes crossing the wire are normalised to 0..1 of the video frame, so they work
at any screen size and resolution.

Binary frame format (browser -> server):
    byte 0      : 0x01 = regular frame, 0x02 = init frame for the pending annotation(s)
    bytes 1..   : JPEG image
The init frame is the snapshot taken at the moment the expert started drawing, so the
tracker locks onto what the expert actually saw, not what arrived a second later.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

import cv2
import numpy as np

from .config import settings

log = logging.getLogger("tracking")

FRAME_REGULAR = 0x01
FRAME_INIT = 0x02
MIN_BOX_PX = 12


def _create_cv_tracker():
    algo = settings.tracker_algo
    factories = {
        "csrt": ["TrackerCSRT_create", "legacy.TrackerCSRT_create"],
        "kcf": ["TrackerKCF_create", "legacy.TrackerKCF_create"],
        "mil": ["TrackerMIL_create"],
    }
    for name in factories.get(algo, []) + factories["mil"]:
        obj = cv2
        try:
            for part in name.split("."):
                obj = getattr(obj, part)
            return obj()
        except AttributeError:
            continue
    raise RuntimeError("No OpenCV tracker available. Install opencv-contrib-python-headless.")


def _decode(jpeg: bytes) -> np.ndarray | None:
    arr = np.frombuffer(jpeg, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _to_pixels(box: dict, w: int, h: int) -> tuple[int, int, int, int]:
    x = int(round(box["x"] * w))
    y = int(round(box["y"] * h))
    bw = max(MIN_BOX_PX, int(round(box["w"] * w)))
    bh = max(MIN_BOX_PX, int(round(box["h"] * h)))
    x = min(max(0, x), w - bw)
    y = min(max(0, y), h - bh)
    return x, y, bw, bh


def _to_norm(px: tuple, w: int, h: int) -> dict:
    x, y, bw, bh = px
    return {"x": x / w, "y": y / h, "w": bw / w, "h": bh / h}


@dataclass
class _Tracked:
    tracker: object
    lost_frames: int = 0
    status: str = "ok"  # ok | lost


class RoomTracking:
    """All trackers for one room. Thread-safe: `process` runs in a worker thread."""

    def __init__(self):
        self._lock = threading.Lock()
        self._trackers: dict[str, _Tracked] = {}
        self._pending: dict[str, dict] = {}  # ann_id -> normalised anchor box
        self.busy = False

    # -- called from the event loop ---------------------------------------------------
    def add(self, ann_id: str, anchor: dict):
        """Start (or restart, after the expert moved it) tracking an annotation."""
        with self._lock:
            self._trackers.pop(ann_id, None)
            self._pending[ann_id] = anchor

    def remove(self, ann_id: str):
        with self._lock:
            self._trackers.pop(ann_id, None)
            self._pending.pop(ann_id, None)

    def clear(self):
        with self._lock:
            self._trackers.clear()
            self._pending.clear()

    @property
    def active(self) -> bool:
        return bool(self._trackers or self._pending)

    # -- called in a worker thread ----------------------------------------------------
    def process(self, message: bytes) -> list[dict]:
        """Handle one binary frame message. Returns anchor updates to broadcast."""
        if len(message) < 2:
            return []
        kind, jpeg = message[0], message[1:]
        frame = _decode(jpeg)
        if frame is None:
            return []
        h, w = frame.shape[:2]
        updates: list[dict] = []

        with self._lock:
            # 1. Initialise anything waiting for a frame.
            for ann_id, anchor in list(self._pending.items()):
                tracker = _create_cv_tracker()
                try:
                    tracker.init(frame, _to_pixels(anchor, w, h))
                except cv2.error as exc:
                    log.warning("tracker init failed for %s: %s", ann_id, exc)
                    continue
                self._trackers[ann_id] = _Tracked(tracker)
                del self._pending[ann_id]

            # An init frame is an older snapshot; don't feed it to running trackers.
            if kind == FRAME_INIT:
                return []

            # 2. Advance every tracker.
            for ann_id, t in self._trackers.items():
                try:
                    ok, box = t.tracker.update(frame)
                except cv2.error:
                    ok, box = False, None
                if ok and box[2] > 0 and box[3] > 0:
                    t.lost_frames = 0
                    t.status = "ok"
                    px = tuple(int(v) for v in box)
                    updates.append({"id": ann_id, "status": "ok", "anchor": _to_norm(px, w, h)})
                else:
                    t.lost_frames += 1
                    if t.lost_frames >= settings.tracker_lost_frames and t.status != "lost":
                        t.status = "lost"
                        updates.append({"id": ann_id, "status": "lost"})
        return updates
