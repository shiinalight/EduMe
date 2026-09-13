"""Real application integration tests; isolated SQLite and no outbound network."""
from __future__ import annotations

import asyncio
import copy
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

import capture_library as library
import main
import math_capture
from heygen_video import HeyGenClient, create_video_router

IMAGE = "data:image/png;base64,iVBORw0KGgo="
QUESTION = {"label": "1", "text": "Find the area of the circle.", "latex": "r=7",
            "diagram_description": "A circle with radius 7.", "ambiguities": ["Confirm the radius label."]}
DOCUMENT = {"title": "Reviewed geometry", "sourceType": "photo", "questions": [QUESTION], "reviewed": True}
LINE = {"text": "2 + 2 = 5", "latex": "2+2=5", "legibility": "uncertain", "ambiguities": ["5 or S"]}


@pytest.fixture(autouse=True)
def isolated_backend(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATABASE_PATH", tmp_path / "unified.sqlite3")
    for name in ("GEMINI_API_KEY", "GEMINI_MODEL", "ELEVENLABS_API_KEY", "FIRECRAWL_API_KEY", "HEYGEN_API_KEY", "INKMATH_OCR_URL"):
        monkeypatch.delenv(name, raising=False)
    main.initialize_database()
    # Initialize the existing HeyGen schema on this isolated host DB; do not remount routes.
    create_video_router(main.authenticated_student, main.database_connection)

    def no_network(*args, **kwargs):
        pytest.fail("Unmocked outbound network request")

    async def no_async_network(*args, **kwargs):
        pytest.fail("Unmocked outbound network request")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", no_network)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", no_async_network)


def register():
    client = TestClient(main.app)
    response = client.post("/auth/register", json={
        "fullName": "Library Student", "email": f"{uuid4()}@example.test", "password": "isolated-password",
        "grade": 8, "country": "United States", "state": "Oregon",
    })
    assert response.status_code == 201
    return client


@pytest.fixture
def learner():
    return register()


def private(response, status=200):
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def notebook(client, **overrides):
    return private(client.post("/api/notebooks", json={**copy.deepcopy(DOCUMENT), **overrides}), 201)


def imported_session(client):
    saved = notebook(client)
    result = private(client.post(f"/api/notebooks/{saved['id']}/questions/0/practice"), 201)
    return saved, result


def step(client, session_id, text="x=4", confidence=0.99):
    return client.post(f"/learning-sessions/{session_id}/steps", json={"rawLatex": text, "confidence": confidence, "timestamp": 42})


def test_real_app_mounts_capture_library_and_existing_ui_without_duplicates():
    paths = main.app.openapi()["paths"]
    expected = ["/api/recognize", "/api/recognize-worksheet", "/api/capture/config", "/api/notebooks",
                "/api/notebooks/{notebook_id}", "/api/notebooks/{notebook_id}/questions/{index}/practice",
                "/voice/transcribe", "/voice/math-json", "/import-problem-url", "/api/heygen/videos"]
    for path in expected:
        assert path in paths
    route_methods = [(route.path, method) for route in main.app.routes if hasattr(route, "methods") for method in route.methods]
    assert len(route_methods) == len(set(route_methods))
    assert TestClient(main.app).get("/app/").status_code == 200


@pytest.mark.parametrize("path", ["/api/notebooks", "/api/recognize", "/api/recognize-worksheet",
                                  "/recognize-handwriting", "/recognize-handwriting/inkmath",
                                  "/voice/transcribe", "/voice/math-json", "/import-problem-url",
                                  "/learning-sessions", "/learning-sessions/unknown/steps",
                                  "/learning-sessions/unknown/explain-step", "/api/notebooks/unknown/questions/0/practice"])
def test_authentication_precedes_body_parsing(path):
    client = TestClient(main.app)
    private(client.post(path, content=b"not-json", headers={"Content-Type": "application/json"}), 401)
    client.cookies.set("math_tutor_session", "invalid-session")
    private(client.post(path, json={}), 401)


@pytest.mark.parametrize("path", ["/api/notebooks", "/api/notebooks/unknown", "/api/capture/config", "/learning-sessions/unknown/review"])
def test_private_gets_require_authentication(path):
    private(TestClient(main.app).get(path), 401)


@pytest.mark.parametrize("path", ["/api/notebooks", "/recognize-handwriting", "/recognize-handwriting/inkmath",
                                  "/voice/transcribe", "/voice/math-json", "/import-problem-url", "/learning-sessions"])
@pytest.mark.parametrize("headers", [{"Origin": "https://evil.example.org"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}])
def test_existing_costly_and_library_routes_reject_cross_origin_before_provider(learner, path, headers):
    private(learner.post(path, json={}, headers=headers), 403)


def test_same_origin_and_no_origin_clients_can_save_and_read(learner):
    result = private(learner.post("/api/notebooks", json=DOCUMENT, headers={"Origin": "http://testserver:80"}), 201)
    assert private(learner.get(f"/api/notebooks/{result['id']}")) == result
    private(learner.get("/api/notebooks", headers={"Origin": "https://evil.example.org"}), 403)


@pytest.mark.parametrize("source_type", ["manual", "photo", "url", "voice"])
def test_reviewed_library_roundtrip_and_persistence_in_existing_sqlite(learner, source_type):
    saved = notebook(learner, sourceType=source_type, sourceUrl="https://lessons.example.org/circles#question1")
    assert saved == {**DOCUMENT, "sourceType": source_type, "sourceUrl": "https://lessons.example.org/circles", "id": saved["id"]}
    assert private(learner.get("/api/notebooks")) == {"notebooks": [saved]}
    main.initialize_database()  # Schema initialization must preserve persisted data.
    reopened = TestClient(main.app)
    reopened.cookies.update(learner.cookies)
    assert private(reopened.get(f"/api/notebooks/{saved['id']}")) == saved
    with main.database_connection() as db:
        row = db.execute("SELECT * FROM capture_notebooks WHERE id = ?", (saved["id"],)).fetchone()
        assert row["student_id"] == learner.get("/me").json()["id"]
        assert json.loads(row["questions_json"]) == [QUESTION]
        assert row["reviewed"] == 1


@pytest.mark.parametrize("reviewed", [False, None, 0, 1, "true", "false", []])
def test_review_must_be_literal_boolean_true(learner, reviewed):
    private(learner.post("/api/notebooks", json={**DOCUMENT, "reviewed": reviewed}), 422)


@pytest.mark.parametrize("change", [
    {"student_id": 2}, {"studentId": 2}, {"owner": "someone"}, {"id": "forged"}, {"image": IMAGE}, {"audioData": "private-audio"},
    {"apiKey": "private-key"}, {"title": " "}, {"title": "x" * 201}, {"sourceType": "generated"},
    {"questions": []}, {"questions": [QUESTION] * 101}, {"questions": [{**QUESTION, "reviewed": True}]},
    {"questions": [{**QUESTION, "ownerId": 2}]}, {"questions": [{**QUESTION, "text": "x" * 16001}]},
    {"questions": [{**QUESTION, "label": "x" * 201}]}, {"questions": [{**QUESTION, "ambiguities": ["?"] * 21}]},
    {"questions": [{**QUESTION, "ambiguities": ["?" * 1001]}]}, {"questions": [{"text": " ", "latex": " "}]},
    {"questions": [{**QUESTION, "text": IMAGE}]}, {"questions": [{**QUESTION, "latex": "data:audio/webm;base64,AAAA"}]},
    {"questions": [{**QUESTION, "text": "\ud800"}]},
])
def test_spoofing_media_and_excess_fields_are_rejected_without_storage(learner, change):
    # ASCII JSON keeps a lone surrogate on the wire for validation rather than encoding it client-side.
    response = learner.post("/api/notebooks", content=json.dumps({**DOCUMENT, **change}), headers={"Content-Type": "application/json"})
    private(response, 422)
    assert "private-key" not in response.text and IMAGE not in response.text
    assert private(learner.get("/api/notebooks")) == {"notebooks": []}


def test_review_is_required_and_partial_question_fields_have_safe_defaults(learner):
    draft = {k: v for k, v in DOCUMENT.items() if k != "reviewed"}
    private(learner.post("/api/notebooks", json=draft), 422)
    saved = notebook(learner, questions=[{"text": "State your givens."}])
    assert saved["questions"] == [{"label": "", "text": "State your givens.", "latex": "", "diagram_description": "", "ambiguities": []}]
    assert saved["sourceUrl"] is None


@pytest.mark.parametrize("url", ["file:///tmp/a", "javascript:alert(1)", "http://127.0.0.1/q", "http://[::1]/q", "http://192.168.1.1/q",
                                 "http://8.8.8.8/q", "http://localhost/q", "http://intranet.local/q", "http://2130706433/q", "http://127.1/q",
                                 "https://user:password@example.org/q", "https://example.org:8001/q", "https://example.org:bad/q",
                                 "https://example.org/q?api_key=private-key", "https://example.org/q?token=private-token", "https://example.org\\@localhost/q"])
def test_source_urls_reject_nonpublic_or_credential_references(learner, url):
    private(learner.post("/api/notebooks", json={**DOCUMENT, "sourceUrl": url}), 422)


def test_notebooks_and_all_imported_session_actions_are_owner_scoped(learner):
    saved, session = imported_session(learner)
    other = register()
    assert private(other.get("/api/notebooks")) == {"notebooks": []}
    private(other.get(f"/api/notebooks/{saved['id']}"), 404)
    private(other.post(f"/api/notebooks/{saved['id']}/questions/0/practice"), 404)
    private(step(other, session["sessionId"]), 404)
    private(other.get(f"/learning-sessions/{session['sessionId']}/review"), 404)
    private(other.post(f"/learning-sessions/{session['sessionId']}/explain-step", json={"rawLatex": "x=4"}), 404)
    assert private(learner.get(f"/learning-sessions/{session['sessionId']}/review"))["findings"] == []


@pytest.mark.parametrize("index", [-1, 1, 1000000, "not-an-index"])
def test_practice_question_index_is_zero_based_and_bounded(learner, index):
    saved = notebook(learner)
    private(learner.post(f"/api/notebooks/{saved['id']}/questions/{index}/practice"), 422 if isinstance(index, str) else 404)


def test_practice_rejects_spoofed_owner_body(learner):
    saved = notebook(learner)
    private(learner.post(f"/api/notebooks/{saved['id']}/questions/0/practice", json={"studentId": 2}), 422)


def test_imported_steps_never_use_authored_checker_or_paid_explanation(learner, monkeypatch):
    saved, session = imported_session(learner)
    assert set(session) == {"sessionId", "problemId", "topic", "prompt", "goal", "foundation", "nextStep", "tutor", "imported"}
    assert session["imported"] is True and session["nextStep"] == 0
    assert session["problemId"] == f"imported:{saved['id']}:0"
    assert QUESTION["text"] in session["prompt"] and QUESTION["diagram_description"] in session["prompt"]
    assert session["tutor"]["mode"] == "guided" and session["tutor"]["workedExample"] is None
    assert "not automatically graded" in session["goal"]

    def forbidden(*args, **kwargs):
        pytest.fail("Imported question reached authored or paid tutoring")

    for name in ("practice_problem", "parse_equation", "gemini_step_explanation", "adaptive_tutor_guidance", "record_strategy_outcome"):
        monkeypatch.setattr(main, name, forbidden)
    texts = ["a^2+b^2=c^2", "c=5", "c=13", "c=17", "2x+3=11", "x=4", "not an equation", "2+2=5"]
    for index, text in enumerate(texts):
        result = private(step(learner, session["sessionId"], text, confidence=0.1 if index == 0 else 1.0))
        assert (result["status"], result["errorType"], result["assessment"]) == ("unclear", "ungraded", "ungraded")
        assert result["saved"] is True
        assert result["stepAccepted"] is False and result["complete"] is False
        assert result["stepIndex"] == index and result["nextStep"] == index + 1
        assert "not automatically graded" in result["hint"]
    review = private(learner.get(f"/learning-sessions/{session['sessionId']}/review"))
    assert review["complete"] is False and review["assessment"] == "ungraded"
    assert [finding["rawLatex"] for finding in review["findings"]] == texts
    assert all(finding["errorType"] == "ungraded" for finding in review["findings"])
    response = private(learner.post(f"/learning-sessions/{session['sessionId']}/explain-step", json={"rawLatex": "x=4", "errorType": "ungraded"}))
    assert response["provider"] == "Coach" and response["assessment"] == "ungraded"
    assert "no authored solution" in response["explanation"]
    private(learner.post(f"/learning-sessions/{session['sessionId']}/explain-step", json={"rawLatex": "invented"}), 404)
    private(learner.post(f"/learning-sessions/{session['sessionId']}/explain-step", json={"rawLatex": "x=4", "errorType": "correct"}), 422)
    with main.database_connection() as db:
        assert db.execute("SELECT COUNT(*) FROM tutor_strategy_events").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM session_tutor_state").fetchone()[0] == 0
        assert db.execute("SELECT next_step FROM practice_sessions WHERE id = ?", (session["sessionId"],)).fetchone()[0] == len(texts)
        assert {tuple(row) for row in db.execute("SELECT status, error_type FROM practice_steps")} == {("unclear", "ungraded")}
    main.initialize_database()
    assert private(learner.get(f"/learning-sessions/{session['sessionId']}/review")) == review


def test_imported_steps_and_session_growth_are_bounded(learner):
    _, session = imported_session(learner)
    private(step(learner, session["sessionId"], "x" * 16001), 422)
    private(step(learner, session["sessionId"], "x" * 16000))
    with main.database_connection() as db:
        db.execute("UPDATE practice_sessions SET next_step = ? WHERE id = ?", (library.MAX_SAVED_STEPS, session["sessionId"]))
    private(step(learner, session["sessionId"]), 409)


def test_imported_session_works_with_existing_heygen_ownership(learner, monkeypatch):
    _, session = imported_session(learner)
    sid = session["sessionId"]
    assert learner.get("/api/heygen/videos", params={"sessionId": sid}).json() == {"videos": []}
    other = register()
    assert other.get("/api/heygen/videos", params={"sessionId": sid}).status_code == 404
    calls = []

    def fake_create(self, value, request_key):
        calls.append((value.sessionId, request_key))
        return "mock-video"

    monkeypatch.setattr(HeyGenClient, "create", fake_create)
    payload = {"sessionId": sid, "requestId": str(uuid4()), "script": "Read the question and identify the given information.",
               "avatarId": "mock-avatar", "voiceId": "", "reviewed": True}
    assert other.post("/api/heygen/videos", json=payload).status_code == 404
    response = learner.post("/api/heygen/videos", json=payload)
    assert response.status_code == 202 and response.json()["sessionId"] == sid
    assert len(calls) == 1 and calls[0][0] == sid


@pytest.mark.parametrize("path,kind", [("/api/recognize", "handwriting"), ("/api/recognize-worksheet", "worksheet")])
def test_mounted_gemini_routes_use_real_auth_and_capture_provider(learner, monkeypatch, path, kind):
    calls = []

    async def fake_capture(self, requested_kind, image_data, *, student_id=None):
        calls.append((requested_kind, image_data, student_id))
        return {"source": "gemini", "needs_review": True, "lines": [LINE]} if requested_kind == "handwriting" else {"questions": [QUESTION], "needs_review": True}

    monkeypatch.setattr(math_capture.CaptureClient, "recognize_document", fake_capture)
    assert private(learner.post(path, json={"image": IMAGE}))["needs_review"] is True
    assert calls == [(kind, IMAGE, str(learner.get("/me").json()["id"]))]


@pytest.mark.parametrize("path", ["/recognize-handwriting", "/recognize-handwriting/inkmath"])
def test_legacy_inkmath_adapter_uses_direct_local_python_by_default(learner, monkeypatch, path):
    calls = []

    async def local_capture(kind, image):
        calls.append((kind, image))
        return {"lines": [LINE], "warnings": ["Review it"], "model": "mock-gemini"}

    monkeypatch.setattr(math_capture, "recognize_document", local_capture)
    response = private(learner.post(path, json={"imageData": IMAGE, "sessionId": "canvas", "stepIndex": 0, "providerId": "inkmath"}))
    assert calls == [("handwriting", IMAGE)]
    if path.endswith("inkmath"):
        assert response["lines"] == [LINE] and response["model"] == "mock-gemini"
    else:
        assert response["rawLatex"] == "2+2=5" and response["confidence"] == 0.55


def test_explicit_inkmath_url_retains_legacy_override_without_local_call(learner, monkeypatch):
    monkeypatch.setenv("INKMATH_OCR_URL", "http://legacy.example.org/api/recognize")
    calls = []

    async def post(self, url, **kwargs):
        calls.append((url, kwargs["json"]))
        return httpx.Response(200, request=httpx.Request("POST", url), json={"lines": [LINE], "warnings": []})

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    response = private(learner.post("/recognize-handwriting/inkmath", json={"imageData": IMAGE, "sessionId": "canvas", "stepIndex": 0, "providerId": "inkmath"}))
    assert response["lines"] == [LINE]
    assert calls == [("http://legacy.example.org/api/recognize", {"image": IMAGE})]


@pytest.mark.parametrize("error", [ValueError("private-provider-detail"), httpx.ConnectError("private-provider-detail"), RuntimeError("private-provider-detail")])
def test_old_ocr_provider_failures_are_sanitized_and_not_cached(learner, monkeypatch, error):
    async def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(math_capture, "recognize_document", fail)
    response = learner.post("/recognize-handwriting/inkmath", json={"imageData": IMAGE, "sessionId": "canvas", "stepIndex": 0, "providerId": "inkmath"})
    private(response, 500 if isinstance(error, RuntimeError) else 503)
    assert "private-provider-detail" not in response.text and "3000" not in response.text


@pytest.mark.parametrize("path,limit", [("/api/notebooks", library.MAX_NOTEBOOK_BYTES), ("/recognize-handwriting", 9 * 1024 * 1024),
                                        ("/voice/transcribe", 9 * 1024 * 1024), ("/voice/math-json", 64 * 1024), ("/import-problem-url", 64 * 1024)])
def test_request_limits_apply_before_parsing_or_provider_calls(learner, path, limit):
    private(learner.post(path, content="{}", headers={"Content-Type": "application/json", "Content-Length": str(limit + 1)}), 413)
    private(learner.post(path, content=b" " * (limit + 1), headers={"Content-Type": "application/json"}), 413)


@pytest.mark.parametrize("body,headers,status", [
    (b"{}", {"Content-Type": "text/plain"}, 415),
    (b"{}", {"Content-Type": "application/json", "Content-Encoding": "gzip"}, 415),
    (b"{}", {"Content-Type": "application/json", "Content-Length": "bad"}, 400),
    (b"{}", {"Content-Type": "application/json", "Content-Length": "1"}, 400),
    (b'{"reviewed":false,"reviewed":true}', {"Content-Type": "application/json"}, 422),
    (b'{"title":NaN}', {"Content-Type": "application/json"}, 422),
])
def test_private_body_validation_is_strict_and_sanitized(learner, body, headers, status):
    private(learner.post("/api/notebooks", content=body, headers=headers), status)


def test_chunked_body_without_content_length_is_bounded(learner):
    async def run():
        async def chunks():
            for _ in range(5):
                yield b" " * (64 * 1024)

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://testserver", cookies=learner.cookies) as client:
            return await client.post("/api/notebooks", content=chunks(), headers={"Content-Type": "application/json"})

    private(asyncio.run(run()), 413)


def test_logout_returns_valid_no_content_status_and_revokes_cookie(learner):
    response = learner.post('/auth/logout')
    assert response.status_code == 204
    assert response.content == b''
    assert 'math_tutor_session' not in learner.cookies
    assert learner.get('/me').status_code == 401
    assert learner.post('/auth/logout').status_code == 204