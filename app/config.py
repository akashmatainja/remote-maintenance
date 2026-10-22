"""Application settings, read from environment variables (.env supported)."""
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


@dataclass(frozen=True)
class Settings:
    # "local" = built-in peer-to-peer WebRTC for testing, "jitsi" = your Jitsi server
    video_backend: str = os.getenv("VIDEO_BACKEND", "local").lower()
    # Comma-separated ICE servers for local mode, e.g. stun:stun.l.google.com:19302
    local_ice_servers: str = os.getenv("LOCAL_ICE_SERVERS", "stun:stun.l.google.com:19302")
    jitsi_domain: str = os.getenv("JITSI_DOMAIN", "meet.example.com")
    jitsi_xmpp_domain: str = os.getenv("JITSI_XMPP_DOMAIN", os.getenv("JITSI_DOMAIN", "meet.example.com"))
    jitsi_muc_domain: str = os.getenv(
        "JITSI_MUC_DOMAIN", "conference." + os.getenv("JITSI_DOMAIN", "meet.example.com")
    )
    jitsi_app_id: str = os.getenv("JITSI_APP_ID", "")
    jitsi_app_secret: str = os.getenv("JITSI_APP_SECRET", "")

    database_path: Path = BASE_DIR / os.getenv("DATABASE_PATH", "data/maintenance.db")
    cameras_file: Path = BASE_DIR / os.getenv("CAMERAS_FILE", "cameras.json")

    tracker_algo: str = os.getenv("TRACKER_ALGO", "csrt").lower()
    tracker_lost_frames: int = int(os.getenv("TRACKER_LOST_FRAMES", "15"))

    @property
    def jwt_enabled(self) -> bool:
        return bool(self.jitsi_app_id and self.jitsi_app_secret)


settings = Settings()


def load_cameras() -> dict:
    """Room code -> ONVIF camera config. Missing file means every room is handheld."""
    if not settings.cameras_file.exists():
        return {}
    data = json.loads(settings.cameras_file.read_text())
    return {k.upper(): v for k, v in data.items() if not k.startswith("_")}
