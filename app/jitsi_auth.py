"""JWT tokens for a self-hosted Jitsi server using Prosody token authentication.

Server side (Debian install):  apt install jitsi-meet-tokens
  and set the same app_id / app_secret you put in .env.
docker-jitsi-meet:  ENABLE_AUTH=1, AUTH_TYPE=jwt, JWT_APP_ID=..., JWT_APP_SECRET=...
"""
import time
import uuid

import jwt

from .config import settings


def make_token(room: str, name: str, role: str, ttl_seconds: int = 4 * 3600) -> str | None:
    if not settings.jwt_enabled:
        return None
    now = int(time.time())
    is_expert = role == "expert"
    payload = {
        "aud": settings.jitsi_app_id,
        "iss": settings.jitsi_app_id,
        "sub": settings.jitsi_xmpp_domain,
        "room": room.lower(),  # lib-jitsi-meet requires lowercase room names
        "iat": now,
        "nbf": now - 10,
        "exp": now + ttl_seconds,
        "context": {
            "user": {
                "id": str(uuid.uuid4()),
                "name": name,
                "moderator": is_expert,
                "affiliation": "owner" if is_expert else "member",
            },
            "features": {"recording": is_expert, "livestreaming": False},
        },
    }
    return jwt.encode(payload, settings.jitsi_app_secret, algorithm="HS256")
