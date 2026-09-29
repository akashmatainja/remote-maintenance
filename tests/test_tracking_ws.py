"""End-to-end check without Jitsi: an expert socket draws a ring around a moving square
and streams frames; a technician socket must receive anchor updates that follow it."""
import json

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.main import app

W, H = 480, 270


def frame(x, y):
    img = np.full((H, W, 3), 40, np.uint8)
    cv2.rectangle(img, (0, 200), (W, H), (70, 70, 70), -1)
    cv2.circle(img, (x + 25, y + 25), 25, (60, 160, 230), -1)
    cv2.circle(img, (x + 25, y + 25), 10, (20, 20, 20), -1)
    ok, jpg = cv2.imencode(".jpg", img)
    return jpg.tobytes()


def recv_until(ws, kind, limit=50):
    for _ in range(limit):
        m = json.loads(ws.receive_text())
        if m["type"] == kind:
            return m
    raise AssertionError(f"no {kind}")


def test_annotation_follows_object():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/TEST42?role=expert&name=Exp") as exp, \
             client.websocket_connect("/ws/TEST42?role=technician&name=Tech") as tech:
            state = recv_until(exp, "state")
            assert state["tracking_source"] is True
            # drain presence/tracking_source chatter
            tech_msgs = []

            x, y = 60, 80
            ann = {"id": "a1", "kind": "ring", "color": "#f0a534", "tracked": True,
                   "anchor": {"x": x / W, "y": y / H, "w": 50 / W, "h": 50 / H}, "shape": {}}
            exp.send_text(json.dumps({"type": "ann_add", "ann": ann}))
            exp.send_bytes(b"\x02" + frame(x, y))           # init frame
            recv_until(exp, "frame_ack")

            last = None
            for step in range(1, 25):
                x += 8; y += 2
                exp.send_bytes(b"\x01" + frame(x, y))
                while True:
                    m = json.loads(exp.receive_text())
                    if m["type"] == "track":
                        last = m["updates"][0]
                    if m["type"] == "frame_ack":
                        break
            assert last and last["status"] == "ok"
            got_x = last["anchor"]["x"] * W
            assert abs(got_x - x) < 12, (got_x, x)

            # technician received the annotation and the track updates
            seen = set()
            for _ in range(60):
                m = json.loads(tech.receive_text())
                seen.add(m["type"])
                if m["type"] == "track":
                    break
            assert {"ann_add", "track"} <= seen

            # handheld PTZ is forwarded as guidance
            exp.send_text(json.dumps({"type": "ptz", "action": "move", "value": "left"}))
            for _ in range(200):
                m = json.loads(tech.receive_text())
                if m["type"] == "guide":
                    assert m["value"] == "left"
                    break
            else:
                raise AssertionError("no guide message")


def test_pages_render():
    with TestClient(app) as client:
        assert client.get("/").status_code == 200
        r = client.get("/remote-camera?room=7K42QX&role=expert&name=R.%20Banerjee")
        assert r.status_code == 200 and "PTZ control" in r.text
        assert client.get("/remote-camera?room=7K42QX&role=technician").status_code == 200
        assert client.get("/sessions").status_code == 200
        assert client.get("/machines").status_code == 200
        cfg = client.get("/api/jitsi-config?room=7K42QX&role=expert&name=A").json()
        if cfg["backend"] == "jitsi":
            assert cfg["room"] == "7k42qx"  # lib-jitsi-meet needs lowercase room names
        else:
            assert cfg["room"] == "7K42QX" and "iceServers" in cfg
