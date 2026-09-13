import json
import sqlite3
import time
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from heygen_video import HeyGenClient, VideoRequest, create_video_router, public_https


def draft(**overrides):
    return {"sessionId": "practice-a", "requestId": str(uuid4()), "script": "Square each side, then add the two shorter-side squares.", "avatarId": "public_look", "voiceId": "", "reviewed": True, **overrides}


def test_provider_uses_current_v3_contract_and_idempotency_without_learner_details():
    calls = []

    def handle(request):
        calls.append(request)
        assert request.url == "https://api.heygen.com/v3/videos"
        assert request.headers["x-api-key"] == "secret-test-key"
        assert request.headers["idempotency-key"] == "edume:1:unique"
        body = json.loads(request.content)
        assert body == {"type": "avatar", "avatar_id": "public_look", "script": draft()["script"], "title": "Math coach explanation", "resolution": "720p", "aspect_ratio": "16:9"}
        return httpx.Response(200, json={"data": {"video_id": "v_123", "status": "waiting"}})

    provider = HeyGenClient("secret-test-key", httpx.MockTransport(handle))
    assert provider.create(VideoRequest(**draft()), "edume:1:unique") == "v_123"
    assert len(calls) == 1


def test_avatar_catalog_filters_unready_incompatible_looks_and_preserves_pagination():
    def handle(request):
        assert request.url.path == "/v3/avatars/looks"
        assert request.url.params["ownership"] == "public"
        assert request.url.params["token"] == "cursor"
        return httpx.Response(200, json={"data": [
            {"id": "ok", "name": "Presenter", "supported_api_engines": ["avatar_iv"], "secret": "not-exposed"},
            {"id": "training", "status": "processing"},
            {"id": "unsupported", "supported_api_engines": ["avatar_v"]},
            {"id": "https://evil.example/"},
        ], "has_more": True, "next_token": "next"})

    result = HeyGenClient("test", httpx.MockTransport(handle)).avatars("cursor")
    assert result == {"avatars": [{"id": "ok", "name": "Presenter"}], "nextToken": "next"}


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 409, 429, 500])
def test_provider_errors_are_sanitized(status):
    provider = HeyGenClient("secret-test-key", httpx.MockTransport(lambda r: httpx.Response(status, json={"error": {"message": "secret-test-key"}})))
    with pytest.raises(HTTPException) as error:
        provider.create(VideoRequest(**draft()), "same-id")
    assert error.value.status_code == (status if status in (409, 429) else 502)
    assert "secret-test-key" not in error.value.detail


def test_missing_key_timeout_network_and_bad_provider_output():
    with pytest.raises(HTTPException, match="HEYGEN_API_KEY"):
        HeyGenClient("").avatars()
    for response in [httpx.Response(200, content="not-json"), httpx.Response(200, json={"data": {}}), httpx.Response(200, json={"data": {"video_id": "../unsafe"}}), httpx.Response(200, content=b"x" * (2 * 1024 * 1024 + 1))]:
        with pytest.raises(HTTPException) as error:
            HeyGenClient("test", httpx.MockTransport(lambda r: response)).create(VideoRequest(**draft()), "same-id")
        assert error.value.status_code == 502
    for exception, expected in [(httpx.ReadTimeout("private detail"), 504), (httpx.ConnectError("private detail"), 502)]:
        def fail(request):
            raise exception
        with pytest.raises(HTTPException) as error:
            HeyGenClient("test", httpx.MockTransport(fail)).avatars()
        assert error.value.status_code == expected
        assert "private detail" not in error.value.detail


@pytest.mark.parametrize("url", ["javascript:alert(1)", "http://files.heygen.ai/v.mp4", "https://127.0.0.1/v", "https://[::1]/v", "https://localhost/v", "https://host.local/v", "https://user:pass@example.com/v", "https://example.com:8000/v"])
def test_delivery_urls_reject_unsafe_locations(url):
    assert public_https(url) is None


def test_status_checks_id_and_only_returns_safe_delivery_details():
    def client(data):
        return HeyGenClient("test", httpx.MockTransport(lambda r: httpx.Response(200, json={"data": data})))
    result = client({"id": "v_1", "status": "completed", "video_url": "https://files.heygen.ai/video/a.mp4?signature=abc", "private": "secret"}).status("v_1")
    assert result["videoUrl"].endswith("?signature=abc")
    assert "private" not in result
    for data in [{"id": "v_other", "status": "pending"}, {"id": "v_1", "status": "unknown"}, {"id": "v_1", "status": "completed", "video_url": "javascript:alert(1)"}]:
        with pytest.raises(HTTPException):
            client(data).status("v_1")
    assert "secret" not in client({"id": "v_1", "status": "failed", "failure_message": "secret"}).status("v_1")["message"]


@pytest.fixture
def service(tmp_path, monkeypatch):
    path = tmp_path / "video-tests.db"

    def connect():
        db = sqlite3.connect(path)
        db.row_factory = sqlite3.Row
        return db

    with connect() as db:
        db.execute("CREATE TABLE practice_sessions (id TEXT PRIMARY KEY, student_id INTEGER)")
        db.executemany("INSERT INTO practice_sessions VALUES (?, ?)", [("practice-a", 1), ("practice-b", 2)])

    def auth(cookie):
        if cookie not in ("one", "two"):
            raise HTTPException(401, "Sign in")
        return {"id": 1 if cookie == "one" else 2}

    class Provider:
        calls = []
        status_calls = []
        fail = False

        def avatars(self, token=""):
            return {"avatars": [{"id": "public_look", "name": "Presenter"}], "nextToken": None}

        def create(self, value, request_key):
            self.calls.append((value, request_key))
            if self.fail:
                raise HTTPException(504, "Provider timeout")
            return "v_1"

        def status(self, video_id):
            self.status_calls.append(video_id)
            return {"status": "completed", "videoUrl": "https://files.heygen.ai/video/v.mp4", "message": None}

    provider = Provider()
    app = FastAPI()
    app.include_router(create_video_router(auth, connect, lambda: provider))
    client = TestClient(app)
    client.cookies.set("math_tutor_session", "one")
    monkeypatch.setenv("HEYGEN_API_KEY", "private-server-key")
    return client, provider, connect


def test_authenticated_routes_require_ownership_and_reject_cross_origin(service):
    client, provider, _ = service
    response = client.get("/api/heygen/config")
    assert response.json()["configured"] is True
    assert response.headers["cache-control"] == "no-store"
    assert "private-server-key" not in response.text
    assert client.post("/api/heygen/videos", json=draft(), headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/heygen/videos", json=draft(), headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/api/heygen/videos", json=draft(sessionId="practice-b")).status_code == 404
    assert client.get("/api/heygen/videos?sessionId=practice-b").status_code == 404
    client.cookies.clear()
    for endpoint in ["config", "avatars", "videos?sessionId=practice-a"]:
        assert client.get("/api/heygen/" + endpoint).status_code == 401
    assert client.post("/api/heygen/videos", json=draft()).status_code == 401
    assert not provider.calls


@pytest.mark.parametrize("changes", [{"script": " "}, {"script": "x" * 4001}, {"reviewed": False}, {"avatarId": "https://example.com"}, {"voiceId": "../voice"}, {"requestId": "bad"}, {"unexpected": "field"}])
def test_validation_rejects_bad_inputs_before_spending_credits(service, changes):
    client, provider, _ = service
    assert client.post("/api/heygen/videos", json=draft(**changes)).status_code == 422
    assert not provider.calls


def test_duplicate_submission_reuses_job_and_other_learners_cannot_read_it(service):
    client, provider, connect = service
    value = draft()
    first = client.post("/api/heygen/videos", json=value, headers={"Origin": "http://testserver"})
    assert first.status_code == 202
    job_id = first.json()["id"]
    assert client.post("/api/heygen/videos", json=value).json()["id"] == job_id
    assert len(provider.calls) == 1
    assert provider.calls[0][1] == f"edume:1:{value['requestId']}"
    assert client.post("/api/heygen/videos", json={**value, "script": "Changed"}).status_code == 409
    listing = client.get("/api/heygen/videos?sessionId=practice-a").json()["videos"]
    assert listing[0]["id"] == job_id
    assert "script" not in listing[0]
    status = client.get(f"/api/heygen/videos/{job_id}").json()
    assert status["status"] == "completed"
    with connect() as db:
        row = db.execute("SELECT * FROM heygen_video_jobs WHERE id = ?", (job_id,)).fetchone()
        assert row["status"] == "completed"
        assert "script" not in row.keys()  # Narration isn't persisted locally.
    client.cookies.set("math_tutor_session", "two")
    assert client.get(f"/api/heygen/videos/{job_id}").status_code == 404
    assert len(provider.status_calls) == 1


def test_uncertain_submission_retries_same_id_and_expires_safely(service):
    client, provider, connect = service
    provider.fail = True
    value = draft()
    assert client.post("/api/heygen/videos", json=value).status_code == 504
    job = client.get("/api/heygen/videos?sessionId=practice-a").json()["videos"][0]
    assert job["status"] == "submission_unknown"
    assert "unconfirmed" in client.get(f"/api/heygen/videos/{job['id']}").json()["message"]
    provider.fail = False
    assert client.post("/api/heygen/videos", json=value).status_code == 202
    assert provider.calls[0][1] == provider.calls[1][1]
    with connect() as db:
        db.execute("UPDATE heygen_video_jobs SET video_id = NULL, created_at = ?", (time.time() - 86400,))
    assert client.post("/api/heygen/videos", json=value).status_code == 409
    assert len(provider.calls) == 2


def test_inflight_submission_and_active_limit_prevent_duplicate_spending(service):
    client, provider, connect = service
    value = draft()
    first = client.post("/api/heygen/videos", json=value).json()
    with connect() as db:
        db.execute("UPDATE heygen_video_jobs SET video_id = NULL, status = 'submitting' WHERE id = ?", (first["id"],))
    assert client.post("/api/heygen/videos", json=value).status_code == 409
    assert len(provider.calls) == 1
    for _ in range(2):
        assert client.post("/api/heygen/videos", json=draft()).status_code == 202
    assert client.post("/api/heygen/videos", json=draft()).status_code == 429
    assert len(provider.calls) == 3


def test_main_app_mounts_optional_feature_without_changing_core_routes():
    from main import app
    client = TestClient(app)
    assert client.get("/").status_code == 200
    assert client.get("/api/heygen/config").status_code == 401
    page = client.get("/app/")
    assert 'id="heygen-dialog"' in page.text
    assert 'type="module" src="/app/app.js"' in page.text
    assert client.get("/app/heygen-video.js").status_code == 200
    assert client.get("/app/heygen-video.css").status_code == 200