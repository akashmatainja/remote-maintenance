"""Room WebSocket hub: annotation sync, object-tracking frames, PTZ/guidance, presence.

Jitsi carries the audio/video. This socket carries everything drawn on top of it.

Messages (JSON text frames)
  client -> server
    {type:"ping", t}
    {type:"ann_add",    ann}        new annotation (see static/js/annotations.js for shape)
    {type:"ann_update", ann}        annotation moved/edited (re-anchors the tracker)
    {type:"ann_remove", id}
    {type:"ann_clear"}
    {type:"ptz", action, value}     move|home|zoom|preset
    {type:"meta", ...}              technician shares camera info (resolution, fps, zoom caps)
    {type:"end"}                    expert ends the session
  server -> client
    {type:"state", annotations, mode, presets, peers, tracking_source}
    {type:"presence", peers}
    {type:"ann_add"|"ann_update"|"ann_remove"|"ann_clear", ...}   relayed
    {type:"track", updates:[{id,status,anchor?}]}                 tracker output
    {type:"frame_ack"}                                            ready for next frame
    {type:"guide", action, value}   handheld mode: tell technician how to move / zoom
    {type:"ptz_result", ok, error?}
    {type:"tracking_source", value} this client should (not) stream frames
    {type:"ended"}
Binary frames: see tracking.py.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field

from fastapi import WebSocket, WebSocketDisconnect

from . import db, ptz
from .tracking import RoomTracking

log = logging.getLogger("realtime")
MAX_TEXT = 64 * 1024
MAX_FRAME = 400 * 1024


@dataclass(eq=False)
class Peer:
    ws: WebSocket
    role: str
    name: str

    async def send(self, msg: dict):
        try:
            await self.ws.send_text(json.dumps(msg))
        except Exception:  # socket already closing
            pass


@dataclass
class Room:
    code: str
    session_id: int
    peers: list[Peer] = field(default_factory=list)
    annotations: dict[str, dict] = field(default_factory=dict)
    tracking: RoomTracking = field(default_factory=RoomTracking)
    frame_source: Peer | None = None
    meta: dict = field(default_factory=dict)

    def roster(self) -> list[dict]:
        return [{"name": p.name, "role": p.role} for p in self.peers]

    async def broadcast(self, msg: dict, exclude: Peer | None = None, role: str | None = None):
        await asyncio.gather(
            *(p.send(msg) for p in self.peers if p is not exclude and (role is None or p.role == role))
        )


class Hub:
    def __init__(self):
        self.rooms: dict[str, Room] = {}

    def room(self, code: str) -> Room:
        code = code.upper()
        if code not in self.rooms:
            self.rooms[code] = Room(code=code, session_id=db.open_session(code))
        return self.rooms[code]

    async def _elect_frame_source(self, room: Room):
        """Exactly one expert streams snapshots for tracking."""
        if room.frame_source in room.peers:
            return
        room.frame_source = next((p for p in room.peers if p.role == "expert"), None)
        for p in room.peers:
            await p.send({"type": "tracking_source", "value": p is room.frame_source})

    # ------------------------------------------------------------------------------
    async def serve(self, ws: WebSocket, code: str, role: str, name: str):
        await ws.accept()
        room = self.room(code)
        peer = Peer(ws, role if role in ("expert", "technician") else "technician", name[:60] or role)
        room.peers.append(peer)
        db.set_participant(room.session_id, peer.role, peer.name)
        db.log_event(room.session_id, "join", {"role": peer.role, "name": peer.name})

        await self._elect_frame_source(room)
        await peer.send({
            "type": "state",
            "annotations": list(room.annotations.values()),
            "mode": ptz.camera_mode(room.code),
            "presets": ptz.preset_names(room.code),
            "peers": room.roster(),
            "meta": room.meta,
            "tracking_source": peer is room.frame_source,
        })
        await room.broadcast({"type": "presence", "peers": room.roster()}, exclude=peer)

        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    await self._on_frame(room, peer, msg["bytes"])
                elif msg.get("text") is not None:
                    if len(msg["text"]) > MAX_TEXT:
                        continue
                    try:
                        data = json.loads(msg["text"])
                    except json.JSONDecodeError:
                        continue
                    if await self._on_message(room, peer, data) == "end":
                        break
        except WebSocketDisconnect:
            pass
        finally:
            if peer in room.peers:
                room.peers.remove(peer)
            db.log_event(room.session_id, "leave", {"role": peer.role, "name": peer.name})
            if room.peers:
                await self._elect_frame_source(room)
                await room.broadcast({"type": "presence", "peers": room.roster()})
            else:
                db.close_session(room.session_id)
                self.rooms.pop(room.code, None)

    # ------------------------------------------------------------------------------
    async def _on_frame(self, room: Room, peer: Peer, data: bytes):
        if peer is not room.frame_source or len(data) > MAX_FRAME:
            return
        if room.tracking.busy:
            await peer.send({"type": "frame_ack", "dropped": True})
            return
        room.tracking.busy = True
        try:
            updates = await asyncio.to_thread(room.tracking.process, data)
        finally:
            room.tracking.busy = False
        await peer.send({"type": "frame_ack"})
        if updates:
            for u in updates:
                ann = room.annotations.get(u["id"])
                if ann:
                    ann["status"] = u["status"]
                    if "anchor" in u:
                        ann["anchor"] = u["anchor"]
            await room.broadcast({"type": "track", "updates": updates})

    async def _on_message(self, room: Room, peer: Peer, data: dict):
        t = data.get("type")

        if t == "ping":
            await peer.send({"type": "pong", "t": data.get("t")})

        elif t in ("ann_add", "ann_update"):
            ann = data.get("ann") or {}
            ann_id = str(ann.get("id", ""))[:64]
            if not ann_id:
                return
            ann["id"] = ann_id
            ann["author"] = peer.name
            ann["status"] = "ok"
            room.annotations[ann_id] = ann
            if ann.get("tracked") and ann.get("anchor"):
                room.tracking.add(ann_id, ann["anchor"])
            else:
                room.tracking.remove(ann_id)
            await room.broadcast({"type": t, "ann": ann}, exclude=peer)
            if t == "ann_add":
                db.log_event(room.session_id, "ann_add", {
                    "kind": ann.get("kind"), "label": ann.get("label", ""), "by": peer.name})

        elif t == "ann_remove":
            ann_id = str(data.get("id", ""))
            room.annotations.pop(ann_id, None)
            room.tracking.remove(ann_id)
            await room.broadcast({"type": "ann_remove", "id": ann_id}, exclude=peer)

        elif t == "ann_clear":
            room.annotations.clear()
            room.tracking.clear()
            await room.broadcast({"type": "ann_clear"}, exclude=peer)

        elif t == "ptz" and peer.role == "expert":
            action, value = data.get("action"), data.get("value")
            if ptz.camera_mode(room.code) == "ptz":
                try:
                    await asyncio.to_thread(ptz.execute, room.code, action, value)
                    await peer.send({"type": "ptz_result", "ok": True, "action": action})
                except Exception as exc:  # camera offline, bad preset, ...
                    log.warning("PTZ %s failed: %s", action, exc)
                    await peer.send({"type": "ptz_result", "ok": False, "error": str(exc)})
            else:
                # Handheld: the technician is the gimbal.
                await room.broadcast({"type": "guide", "action": action, "value": value}, role="technician")
                await peer.send({"type": "ptz_result", "ok": True, "action": action, "guided": True})

        elif t == "meta" and peer.role == "technician":
            room.meta = {k: data[k] for k in ("width", "height", "fps", "zoom", "device") if k in data}
            await room.broadcast({"type": "meta", **room.meta}, exclude=peer)

        elif t == "end" and peer.role == "expert":
            db.log_event(room.session_id, "end", {"by": peer.name})
            await room.broadcast({"type": "ended"})
            return "end"


hub = Hub()
