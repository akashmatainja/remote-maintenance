"""Tiny SQLite layer for sessions and the annotation log (used by the Sessions and Reports pages)."""
import json
import sqlite3
import time
from contextlib import contextmanager

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    machine TEXT,
    work_order TEXT,
    expert TEXT,
    technician TEXT,
    started_at REAL NOT NULL,
    ended_at REAL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    at REAL NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT
);
"""


@contextmanager
def connect():
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with connect() as c:
        c.executescript(SCHEMA)


def open_session(room: str, machine: str = "", work_order: str = "") -> int:
    with connect() as c:
        row = c.execute(
            "SELECT id FROM sessions WHERE room=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1", (room,)
        ).fetchone()
        if row:
            return row["id"]
        cur = c.execute(
            "INSERT INTO sessions(room, machine, work_order, started_at) VALUES (?,?,?,?)",
            (room, machine, work_order, time.time()),
        )
        return cur.lastrowid


def set_participant(session_id: int, role: str, name: str):
    col = "expert" if role == "expert" else "technician"
    with connect() as c:
        c.execute(f"UPDATE sessions SET {col}=? WHERE id=?", (name, session_id))


def close_session(session_id: int):
    with connect() as c:
        c.execute("UPDATE sessions SET ended_at=? WHERE id=? AND ended_at IS NULL", (time.time(), session_id))


def log_event(session_id: int, kind: str, payload: dict | None = None):
    with connect() as c:
        c.execute(
            "INSERT INTO events(session_id, at, kind, payload) VALUES (?,?,?,?)",
            (session_id, time.time(), kind, json.dumps(payload or {})),
        )


def list_sessions(limit: int = 50) -> list[dict]:
    with connect() as c:
        rows = c.execute(
            """SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.session_id=s.id AND e.kind='ann_add') AS marks
               FROM sessions s ORDER BY s.id DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def session_events(session_id: int) -> list[dict]:
    with connect() as c:
        rows = c.execute("SELECT * FROM events WHERE session_id=? ORDER BY at", (session_id,)).fetchall()
        return [dict(r) | {"payload": json.loads(r["payload"] or "{}")} for r in rows]
