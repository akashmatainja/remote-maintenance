"""Tool image library + expert media-state relay."""
import json

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


def _png(w, h, alpha=True):
    img = np.zeros((h, w, 4 if alpha else 3), np.uint8)
    cv2.rectangle(img, (10, 10), (w - 10, h - 10), (40, 120, 220, 255) if alpha else (40, 120, 220), -1)
    return cv2.imencode(".png", img)[1].tobytes()


def test_tool_upload_list_delete(tmp_path, monkeypatch):
    monkeypatch.setattr(type(settings), "tools_dir", property(lambda s: tmp_path), raising=False)
    with TestClient(app) as c:
        r = c.post("/api/tools?name=Torque%20wrench", content=_png(1200, 600), headers={"Content-Type": "image/png"})
        assert r.status_code == 200, r.text
        tool = r.json()
        assert tool["transparent"] and tool["name"] == "Torque wrench"
        assert max(tool["w"], tool["h"]) == 512                  # downscaled
        assert (tmp_path / tool["file"]).exists()
        assert [t["id"] for t in c.get("/api/tools").json()] == [tool["id"]]

        assert c.post("/api/tools?name=x", content=b"<svg onload=alert(1)>").status_code == 400
        assert c.post("/api/tools?name=x", content=b"0" * (5 * 1024 * 1024 + 1)).status_code == 413

        assert c.delete(f"/api/tools/{tool['id']}").json() == {"ok": True}
        assert c.get("/api/tools").json() == []


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
