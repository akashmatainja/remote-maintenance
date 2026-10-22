"""Tool image library + expert media-state relay."""
import json
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.main import app


def _png(w, h, alpha=True):
    img = np.zeros((h, w, 4 if alpha else 3), np.uint8)
    cv2.rectangle(img, (10, 10), (w - 10, h - 10), (40, 120, 220, 255) if alpha else (40, 120, 220), -1)
    return cv2.imencode(".png", img)[1].tobytes()


def test_meeting_tools_live_only_during_meeting():
    glb = (Path(__file__).parent / "wrench3d.glb").read_bytes()
    with TestClient(app) as c:
        # no meeting running yet -> uploads refused
        assert c.post("/api/rooms/TOOLRM/tools?name=x", content=_png(100, 50)).status_code == 409

        with c.websocket_connect("/ws/TOOLRM?role=expert&name=Exp") as exp:
            assert _until(exp, "state")["tools"] == []
            r = c.post("/api/rooms/TOOLRM/tools?name=Torque%20wrench", content=_png(1200, 600),
                       headers={"Content-Type": "image/png"})
            assert r.status_code == 200, r.text
            tool = r.json()
            assert tool["transparent"] and tool["name"] == "Torque wrench" and "data" not in tool
            assert max(tool["w"], tool["h"]) == 512                          # downscaled
            assert _until(exp, "tools")["tools"][0]["id"] == tool["id"]       # expert tray updates live
            img = c.get(tool["url"])
            assert img.status_code == 200 and img.headers["cache-control"] == "private, no-store"

            assert c.post("/api/rooms/TOOLRM/tools?name=x", content=b"<svg onload=alert(1)>").status_code == 400
            assert c.post("/api/rooms/TOOLRM/tools?name=x", content=b"0" * (5 * 1024 * 1024 + 1)).status_code == 400
            assert c.post("/api/rooms/TOOLRM/tools?name=x", content=b"0" * (15 * 1024 * 1024 + 1)).status_code == 413
            bad = b"glTF" + (1).to_bytes(4, "little") + (20).to_bytes(4, "little") + b"\0" * 8   # glTF 1.0
            assert c.post("/api/rooms/TOOLRM/tools?name=x", content=bad).status_code == 400

            m = c.post("/api/rooms/TOOLRM/tools?name=Wrench%203D", content=glb).json()
            assert m["kind"] == "model" and c.get(m["url"]).content == glb
            assert c.delete(f"/api/rooms/TOOLRM/tools/{m['id']}").json() == {"ok": True}
            assert c.get(m["url"]).status_code == 404

            # the meeting ends -> tool images are gone
            exp.send_text(json.dumps({"type": "end"}))
            _until(exp, "ended")
        assert c.get(tool["url"]).status_code == 404
        assert c.get("/api/rooms/TOOLRM/tools").status_code == 409


def _until(ws, kind):
    for _ in range(50):
        m = json.loads(ws.receive_text())
        if m["type"] == kind:
            return m
    raise AssertionError(kind)


def test_expert_media_relayed_and_in_state():
    with TestClient(app) as c:
        with c.websocket_connect("/ws/MEDIA1?role=expert&name=Exp") as exp:
            _until(exp, "state")
            with c.websocket_connect("/ws/MEDIA1?role=technician&name=Tech") as tech:
                _until(tech, "state")
                exp.send_text(json.dumps({"type": "media", "cam": True, "mic": True}))
                m = _until(tech, "media")
                assert (m["name"], m["cam"], m["mic"]) == ("Exp", True, True)
            # a technician joining later gets it in the initial state
            with c.websocket_connect("/ws/MEDIA1?role=technician&name=Tech2") as late:
                st = _until(late, "state")
                assert st["media"] == [{"name": "Exp", "cam": True, "mic": True}]


def test_tools_survive_a_dropped_connection():
    with TestClient(app) as c:
        with c.websocket_connect("/ws/DROPRM?role=expert&name=Exp") as exp:
            _until(exp, "state")
            url = c.post("/api/rooms/DROPRM/tools?name=w", content=_png(64, 64)).json()["url"]
        # socket closed without "end" (Wi-Fi drop): still there while the room waits for a rejoin
        assert c.get(url).status_code == 200
        with c.websocket_connect("/ws/DROPRM?role=expert&name=Exp") as exp:
            assert [t["url"] for t in _until(exp, "state")["tools"]] == [url]
