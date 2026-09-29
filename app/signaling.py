"""Minimal WebRTC signaling for the "local" video backend (testing without a Jitsi server).

Browsers connect directly to each other (peer-to-peer, mesh). This hub only passes
offers, answers and ICE candidates between them. Fine for 2-4 people on a LAN or with a
STUN server; for real deployments switch VIDEO_BACKEND=jitsi.

client -> server: {type:"signal", to, data}
server -> client: {type:"welcome", id, peers:[{id,name,role}]}
                  {type:"joined", peer}, {type:"left", id}
                  {type:"signal", from, data}
"""
import json
import secrets

from fastapi import WebSocket, WebSocketDisconnect


class SignalHub:
    def __init__(self):
        self.rooms: dict[str, dict[str, dict]] = {}

    async def serve(self, ws: WebSocket, room: str, role: str, name: str):
        await ws.accept()
        peers = self.rooms.setdefault(room, {})
        pid = secrets.token_hex(4)
        me = {"id": pid, "name": name[:60] or role, "role": role, "ws": ws}
        public = lambda p: {k: p[k] for k in ("id", "name", "role")}

        await ws.send_text(json.dumps({"type": "welcome", "id": pid, "peers": [public(p) for p in peers.values()]}))
        for p in peers.values():
            await self._send(p, {"type": "joined", "peer": public(me)})
        peers[pid] = me
        try:
            while True:
                msg = json.loads(await ws.receive_text())
                if msg.get("type") == "signal" and msg.get("to") in peers:
                    await self._send(peers[msg["to"]], {"type": "signal", "from": pid, "data": msg.get("data")})
        except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
            pass
        finally:
            peers.pop(pid, None)
            for p in list(peers.values()):
                await self._send(p, {"type": "left", "id": pid})
            if not peers:
                self.rooms.pop(room, None)

    @staticmethod
    async def _send(peer, msg):
        try:
            await peer["ws"].send_text(json.dumps(msg))
        except Exception:
            pass


signal_hub = SignalHub()
