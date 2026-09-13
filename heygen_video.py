"""Optional, authenticated HeyGen integration. No changes to the tutor's policy.

Provider contract: https://developers.heygen.com/reference/create-video.md
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import sqlite3
import time
from collections.abc import Callable
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_SCRIPT = 4000
ID_PATTERN = r"^[A-Za-z0-9_-]{1,200}$"


class VideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    sessionId: str = Field(min_length=1, max_length=200)
    requestId: UUID
    script: str = Field(min_length=1, max_length=MAX_SCRIPT)
    avatarId: str = Field(pattern=ID_PATTERN)
    voiceId: str = Field(default="", max_length=200)
    reviewed: Literal[True]

    @field_validator("voiceId")
    @classmethod
    def valid_voice(cls, value: str) -> str:
        if value and not re.fullmatch(ID_PATTERN, value):
            raise ValueError("Use a HeyGen voice ID, not a URL or API key.")
        return value


def public_https(value: object) -> str | None:
    """Only allow public HTTPS delivery links; never fetch them server-side."""
    if not isinstance(value, str) or len(value) > 8000:
        return None
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        if not host or "." not in host or host.endswith((".localhost", ".local", ".internal", ".test", ".lan")):
            return None
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return value
    except ValueError:
        pass
    return None


class HeyGenClient:
    """Fixed provider endpoint, bounded responses, sanitized errors, no auto-retries."""

    def __init__(self, api_key: str | None = None, transport: httpx.BaseTransport | None = None):
        self.api_key = (api_key if api_key is not None else os.getenv("HEYGEN_API_KEY", "")).strip()
        self.transport = transport

    def request(self, method: str, path: str, *, payload: dict | None = None,
                params: dict | None = None, request_key: str | None = None) -> dict:
        if not self.api_key:
            raise HTTPException(503, "Add HEYGEN_API_KEY to your local .env, save it, and restart the Python app.")
        headers = {"X-Api-Key": self.api_key, "Accept": "application/json"}
        if request_key:
            headers["Idempotency-Key"] = request_key
        try:
            with httpx.Client(timeout=40, follow_redirects=False, transport=self.transport) as client:
                with client.stream(method, "https://api.heygen.com" + path, headers=headers, json=payload, params=params) as response:
                    if not response.is_success:
                        messages = {
                            400: "HeyGen rejected the script, avatar or voice settings. Check the selected IDs and API plan.",
                            401: "HeyGen authentication failed. Check that your saved key is a valid HeyGen API key.",
                            402: "HeyGen API credits are insufficient. Check API billing (separate from website credits).",
                            403: "HeyGen access denied. Check API permissions and access to this avatar or voice.",
                            404: "HeyGen could not find this resource. Check the avatar, voice or video ID.",
                            409: "HeyGen is still handling this request. Wait briefly, then retry the same submission.",
                            429: "HeyGen rate limit or quota reached. Wait before checking again; do not generate another video.",
                        }
                        code = response.status_code
                        raise HTTPException(code if code in (409, 429) else 502, messages.get(code, f"HeyGen is unavailable (HTTP {code}). Check its dashboard before retrying."))
                    chunks = bytearray()
                    for chunk in response.iter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > 2 * 1024 * 1024:
                            raise HTTPException(502, "HeyGen returned an oversized response.")
                    result = json.loads(chunks)
        except httpx.TimeoutException as exc:
            raise HTTPException(504, "HeyGen timed out. A video may still have been submitted. Retry the same request, not a new video.") from exc
        except httpx.RequestError as exc:
            raise HTTPException(502, "Could not reach HeyGen. Check its dashboard before creating another video.") from exc
        except (ValueError, UnicodeError) as exc:
            raise HTTPException(502, "HeyGen returned an unreadable response.") from exc
        if not isinstance(result, dict) or result.get("error"):
            raise HTTPException(502, "HeyGen returned an error. Check your API account and selected settings.")
        return result

    def avatars(self, token: str = "") -> dict:
        params = {"ownership": "public", "limit": 50}
        if token:
            params["token"] = token
        result = self.request("GET", "/v3/avatars/looks", params=params)
        items = result.get("data")
        if not isinstance(items, list):
            raise HTTPException(502, "HeyGen returned an invalid avatar list.")
        avatars = []
        for item in items[:50]:
            if not isinstance(item, dict) or not re.fullmatch(ID_PATTERN, str(item.get("id", ""))):
                continue
            if item.get("status") not in (None, "completed"):
                continue
            engines = item.get("supported_api_engines")
            if isinstance(engines, list) and "avatar_iv" not in engines:
                continue
            avatars.append({"id": item["id"], "name": str(item.get("name", "Avatar"))[:200]})
        token = result.get("next_token")
        return {"avatars": avatars, "nextToken": token if result.get("has_more") and isinstance(token, str) and len(token) <= 2048 else None}

    def create(self, value: VideoRequest, request_key: str) -> str:
        payload = {"type": "avatar", "avatar_id": value.avatarId, "script": value.script,
                   "title": "Math coach explanation", "resolution": "720p", "aspect_ratio": "16:9"}
        if value.voiceId:
            payload["voice_id"] = value.voiceId
        result = self.request("POST", "/v3/videos", payload=payload, request_key=request_key)
        data = result.get("data")
        video_id = data.get("video_id") if isinstance(data, dict) else None
        if not isinstance(video_id, str) or not re.fullmatch(ID_PATTERN, video_id):
            raise HTTPException(502, "HeyGen did not return a video ID. Check its dashboard before trying a new request.")
        return video_id

    def status(self, video_id: str) -> dict:
        if not re.fullmatch(ID_PATTERN, video_id):
            raise HTTPException(502, "Invalid stored video ID.")
        data = self.request("GET", f"/v3/videos/{video_id}").get("data")
        if not isinstance(data, dict) or data.get("id") != video_id:
            raise HTTPException(502, "HeyGen returned invalid video details.")
        state = data.get("status")
        if state not in ("pending", "processing", "completed", "failed"):
            raise HTTPException(502, "HeyGen returned an unknown video status. Check again later.")
        url = public_https(data.get("video_url")) if state == "completed" else None
        if state == "completed" and not url:
            raise HTTPException(502, "The video is complete but its delivery link is unavailable. Check again later.")
        return {"status": state, "videoUrl": url,
                "message": "HeyGen could not render this video. Check its dashboard for details before generating another." if state == "failed" else None}


def create_video_router(authenticate: Callable, connect: Callable[[], sqlite3.Connection],
                        provider_factory: Callable[[], HeyGenClient] = HeyGenClient) -> APIRouter:
    """Inject existing authentication/storage instead of importing or changing the tutor."""
    with connect() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS heygen_video_jobs (
            id TEXT PRIMARY KEY, student_id INTEGER NOT NULL, session_id TEXT NOT NULL,
            request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, video_id TEXT,
            status TEXT NOT NULL, created_at REAL NOT NULL, submitted_at REAL NOT NULL,
            UNIQUE(student_id, request_id)
        )""")

    def student(request: Request, response: Response, math_tutor_session: str | None = Cookie(default=None)):
        response.headers["Cache-Control"] = "no-store"
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin != str(request.base_url).rstrip("/")):
            raise HTTPException(403, "Cross-origin video requests are not allowed.")
        return authenticate(math_tutor_session)

    router = APIRouter(prefix="/api/heygen", tags=["Tutor videos"])

    def owned_session(db, session_id, student_id):
        if db.execute("SELECT id FROM practice_sessions WHERE id = ? AND student_id = ?", (session_id, student_id)).fetchone() is None:
            raise HTTPException(404, "Practice session not found.")

    def public_job(row):
        return {"id": row["id"], "sessionId": row["session_id"], "status": row["status"], "createdAt": row["created_at"], "videoUrl": None}

    @router.get("/config")
    def config(learner=Depends(student)):
        return {"configured": bool(os.getenv("HEYGEN_API_KEY", "").strip()), "maxScriptLength": MAX_SCRIPT,
                "defaultAvatarId": os.getenv("HEYGEN_AVATAR_ID", ""), "defaultVoiceId": os.getenv("HEYGEN_VOICE_ID", "")}

    @router.get("/avatars")
    def avatars(token: str = Query(default="", max_length=2048), learner=Depends(student)):
        return provider_factory().avatars(token)

    @router.get("/videos")
    def videos(sessionId: str = Query(min_length=1, max_length=200), learner=Depends(student)):
        with connect() as db:
            owned_session(db, sessionId, learner["id"])
            rows = db.execute("SELECT * FROM heygen_video_jobs WHERE student_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 10", (learner["id"], sessionId)).fetchall()
        return {"videos": [public_job(row) for row in rows]}

    @router.post("/videos", status_code=202)
    def generate(value: VideoRequest, learner=Depends(student)):
        # The provider's idempotency window is 24 hours; never blindly retry later.
        fingerprint = hashlib.sha256(json.dumps(value.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()
        now = time.time()
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            owned_session(db, value.sessionId, learner["id"])
            previous = db.execute("SELECT * FROM heygen_video_jobs WHERE student_id = ? AND request_id = ?", (learner["id"], str(value.requestId))).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise HTTPException(409, "This submission ID belongs to a different script or selection. Start a new reviewed draft.")
                if previous["video_id"]:
                    return public_job(previous)
                if now - previous["created_at"] >= 23 * 3600:
                    raise HTTPException(409, "The safe retry window has expired. Check HeyGen's dashboard before creating a new video.")
                if previous["status"] == "submitting" and now - previous["submitted_at"] < 90:
                    raise HTTPException(409, "This video is being submitted. Wait before retrying the same request.")
                job_id = previous["id"]
                db.execute("UPDATE heygen_video_jobs SET status = 'submitting', submitted_at = ? WHERE id = ?", (now, job_id))
            else:
                # Keep this local prototype from accidentally creating expensive batches.
                active = db.execute("SELECT COUNT(*) FROM heygen_video_jobs WHERE student_id = ? AND status IN ('submitting', 'pending', 'processing', 'submission_unknown') AND created_at > ?", (learner["id"], now - 86400)).fetchone()[0]
                if active >= 3:
                    raise HTTPException(429, "You already have three active or unconfirmed videos. Check their status or the HeyGen dashboard first.")
                job_id = str(uuid4())
                db.execute("INSERT INTO heygen_video_jobs (id, student_id, session_id, request_id, fingerprint, status, created_at, submitted_at) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?)", (job_id, learner["id"], value.sessionId, str(value.requestId), fingerprint, now, now))
        try:
            video_id = provider_factory().create(value, f"edume:{learner['id']}:{value.requestId}")
        except HTTPException as exc:
            with connect() as db:
                db.execute("UPDATE heygen_video_jobs SET status = ? WHERE id = ?", ("failed" if exc.status_code == 503 else "submission_unknown", job_id))
            raise
        with connect() as db:
            db.execute("UPDATE heygen_video_jobs SET video_id = ?, status = 'pending' WHERE id = ?", (video_id, job_id))
            row = db.execute("SELECT * FROM heygen_video_jobs WHERE id = ?", (job_id,)).fetchone()
        return public_job(row)

    @router.get("/videos/{job_id}")
    def video(job_id: UUID, learner=Depends(student)):
        with connect() as db:
            row = db.execute("SELECT * FROM heygen_video_jobs WHERE id = ? AND student_id = ?", (str(job_id), learner["id"])).fetchone()
        if row is None:
            raise HTTPException(404, "Video not found.")
        result = public_job(row)
        if not row["video_id"]:
            result["message"] = "Submission is unconfirmed. Check HeyGen's dashboard; retry only the same unchanged draft to avoid duplicate charges."
            return result
        details = provider_factory().status(row["video_id"])
        with connect() as db:
            db.execute("UPDATE heygen_video_jobs SET status = ? WHERE id = ?", (details["status"], str(job_id)))
        return {**result, **details}

    return router