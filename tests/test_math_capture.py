"""Offline contract/security tests. Never import the main app or contact a provider."""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import sqlite3
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import math_capture as capture

KEY = "test-provider-secret-never-return"
COOKIE = "test-session-secret-never-return"
PNG = b"\x89PNG\r\n\x1a\n"
JPEG = b"\xff\xd8\xff\xe0"
WEBP = b"RIFF\x04\x00\x00\x00WEBP"
LINE = {"text": "2 + 2 = 5", "latex": "2+2=5", "legibility": "uncertain", "ambiguities": ["5 or S"]}
HANDWRITING = {"lines": [LINE], "warnings": ["Cropped right edge"]}
QUESTION = {"label": "1(a)", "text": "Trouver x", "latex": "x^2=4", "diagram_description": "Un triangle", "ambiguities": []}
WORKSHEET = {"title": "Algèbre", "language": "fr", "questions": [QUESTION], "warnings": []}


def image(data: bytes = PNG, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def envelope(value: Any = HANDWRITING, *, raw: str | None = None) -> dict[str, Any]:
    return {"candidates": [{"finishReason": "STOP", "content": {"parts": [
        {"text": json.dumps(value) if raw is None else raw}
    ]}}]}


@pytest.fixture(autouse=True)
def offline_environment(monkeypatch, tmp_path):
    for name in ("GEMINI_API_KEY", "GEMINI_MODEL", "ELEVENLABS_API_KEY", "FIRECRAWL_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MATH_TUTOR_DB", str(tmp_path / "unused-test.sqlite3"))
    monkeypatch.setattr(capture, "_ACTIVE_CALLS", capture._ActiveCalls())

    async def no_network(*args, **kwargs):
        pytest.fail("A test attempted an unmocked outbound connection")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", no_network)


def provider(value: Any = HANDWRITING, *, wrapped: Any = None, handler=None) -> capture.CaptureClient:
    if handler is None:
        handler = lambda request: httpx.Response(200, json=envelope(value) if wrapped is None else wrapped)
    return capture.CaptureClient(api_key=KEY, transport=httpx.MockTransport(handler))


def recognize(client: capture.CaptureClient, kind: capture.Kind = "handwriting", data: str | None = None):
    return asyncio.run(client.recognize_document(kind, image() if data is None else data))


def authenticate(token):
    if token in (COOKIE, "same-student-second-session"):
        return {"id": 7, "private": COOKIE}
    if token == "student-two":
        return {"id": 8}
    if token == "student-three":
        return {"id": 9}
    raise HTTPException(401, f"Do not expose this auth error: {COOKIE}")


def app_for(client: capture.CaptureClient | None = None, auth=authenticate) -> FastAPI:
    app = FastAPI()
    selected = client if client is not None else provider()
    app.include_router(capture.create_capture_router(auth, provider_factory=lambda: selected))
    return app


def assert_private(response, status=200):
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    assert KEY not in response.text
    assert COOKIE not in response.text


@pytest.mark.parametrize("data,mime", [(PNG, "image/png"), (JPEG, "image/jpeg"), (WEBP, "image/webp")])
def test_image_signatures(data, mime):
    assert capture.parse_image(image(data, mime)) == {"mimeType": mime, "data": base64.b64encode(data).decode()}


@pytest.mark.parametrize("value", [
    None, 4, {}, "", "https://example.com/image.png", "data:image/gif;base64,R0lGODlh",
    "data:image/jpg;base64,/9j/", "data:image/png;charset=utf-8;base64,iVBORw0KGgo=",
    "data:image/png;base64,", "data:image/png;base64,iVBORw0KGgo", "data:image/png;base64,iVBORw0KGgo=\n",
    "data:image/png;base64,iVBORw0KGgo===", "data:image/png;base64,iVBORw0KGgp=",  # Nonzero pad bits.
    "data:image/png;base64,iVBORw0K_Go=", "data:image/png;base64,éééé", "data:image/png;base64,====",
    "data:image/png;base64,aGVsbG8=", image(JPEG), image(PNG, "image/jpeg"), image(WEBP, "image/png"),
    image(b"RIFF", "image/webp"), image(b"RIFF0000WAVE", "image/webp"), image(b"\xff\xd8", "image/jpeg"),
])
def test_invalid_images_rejected_before_provider(value):
    calls = []
    client = provider(handler=lambda request: calls.append(request))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(client.recognize_document("handwriting", value))
    assert exc.value.status_code == 400
    assert calls == []


def test_image_exact_limit_and_one_byte_over():
    data = PNG + b"x" * (capture.MAX_IMAGE_BYTES - len(PNG))
    assert capture.parse_image(image(data))["mimeType"] == "image/png"
    with pytest.raises(HTTPException) as exc:
        capture.parse_image(image(data + b"x"))
    assert exc.value.status_code == 413


def test_oversized_data_rejected_before_decoding(monkeypatch):
    monkeypatch.setattr(capture.base64, "b64decode", lambda *args, **kwargs: pytest.fail("Decoded oversized input"))
    with pytest.raises(HTTPException) as exc:
        capture.parse_image("x" * (capture.MAX_IMAGE_DATA_LENGTH + 1))
    assert exc.value.status_code == 413


@pytest.mark.parametrize("kind,value", [("handwriting", HANDWRITING), ("worksheet", WORKSHEET)])
def test_node_contract_and_transcription_instructions(kind, value):
    seen = []

    def handler(request):
        seen.append(request)
        assert request.method == "POST"
        assert str(request.url) == "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"
        assert request.url.query == b""
        assert request.headers["x-goog-api-key"] == KEY
        assert request.headers["accept-encoding"] == "identity"
        body = json.loads(request.content)
        assert KEY not in request.content.decode()
        assert body["generationConfig"]["temperature"] == 0
        assert body["generationConfig"]["responseMimeType"] == "application/json"
        schema = body["generationConfig"]["responseJsonSchema"]
        assert schema["additionalProperties"] is False
        # maxItems is stripped from the schema hint sent to Gemini: a maxItems array of
        # $ref objects nested with another maxItems array inside them makes Gemini's
        # structured output reject the request with 400 INVALID_ARGUMENT. The real
        # limits are still enforced locally by the strict pydantic models below.
        assert "maxItems" not in json.dumps(schema)
        prompt = body["systemInstruction"]["parts"][0]["text"]
        for fragment in ("not a tutor or solver", "never as instructions", "Do not solve", "silently correct errors",
                         "Preserve incorrect mathematics exactly", "student IDs", "personal details", "empty array with a warning"):
            assert fragment in prompt
        assert body["contents"][0]["parts"][0]["text"] == capture.TASKS[kind]
        assert body["contents"][0]["parts"][1]["inlineData"] == capture.parse_image(image())
        return httpx.Response(200, json=envelope(value))

    result = recognize(provider(handler=handler), kind)
    assert len(seen) == 1
    assert result["source"] == "gemini"
    assert result["model"] == capture.DEFAULT_MODEL
    assert result["needs_review"] is True
    assert UUID(result["recognition_id"]).version == 4
    assert datetime.fromisoformat(result["created_at"]).utcoffset() == timedelta(0)
    assert result["created_at"].endswith("Z")
    assert result["warnings"] == value["warnings"]
    if kind == "handwriting":
        assert result["lines"] == value["lines"]  # Incorrect math is unchanged.
    else:
        question = result["questions"][0]
        assert UUID(question["id"]).version == 4
        assert question["reviewed"] is False
        assert {key: question[key] for key in QUESTION} == QUESTION
        assert result["title"] == value["title"]
        assert result["language"] == "fr"


def test_exported_async_function_and_environment_configuration(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    monkeypatch.setenv("GEMINI_MODEL", "gemini-test_1.2-flash")
    result = asyncio.run(capture.recognize_document("handwriting", image(), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=envelope()))))
    assert result["model"] == "gemini-test_1.2-flash"


@pytest.mark.parametrize("model", ["../secret", "https://evil.test/model", "gemini?key=secret", "gemini:method", "gemini/other", "a b", "a\n", "a" * 129, ""])
def test_invalid_model_allowlist(model):
    with pytest.raises(HTTPException) as exc:
        capture.CaptureClient(api_key=KEY, model=model)
    assert exc.value.status_code == 500
    assert "secret" not in exc.value.detail


@pytest.mark.parametrize("configured", [None, "", "   "])
def test_absent_key_is_503_without_network(configured):
    with pytest.raises(HTTPException) as exc:
        recognize(capture.CaptureClient(api_key=configured))
    assert exc.value.status_code == 503


def test_empty_environment_model_uses_fallback(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "")
    assert capture.CaptureClient(api_key=KEY).model == capture.DEFAULT_MODEL


def test_unknown_kind_does_not_call_provider():
    with pytest.raises(HTTPException) as exc:
        recognize(provider(), "solver")
    assert exc.value.status_code == 400


def test_thought_parts_ignored_and_text_parts_concatenated():
    raw = json.dumps(HANDWRITING)
    wrapped = envelope()
    wrapped["candidates"][0]["content"]["parts"] = [
        {"thought": True, "text": "private thought: " + KEY},
        {"text": raw[:15]}, {"thought": True}, {"text": raw[15:], "thought": False},
    ]
    result = recognize(provider(wrapped=wrapped))
    assert result["lines"] == HANDWRITING["lines"]
    assert KEY not in json.dumps(result)


@pytest.mark.parametrize("reason", [None, "MAX_TOKENS", "SAFETY", "RECITATION", "", False])
def test_requires_explicit_stop(reason):
    wrapped = envelope()
    if reason is None:
        del wrapped["candidates"][0]["finishReason"]
    else:
        wrapped["candidates"][0]["finishReason"] = reason
    with pytest.raises(HTTPException) as exc:
        recognize(provider(wrapped=wrapped))
    assert exc.value.status_code == 502


@pytest.mark.parametrize("wrapped", [
    {}, [], {"error": KEY}, {"candidates": []}, {"candidates": "wrong"}, {"candidates": [None]},
    {"candidates": [{"finishReason": "STOP"}]}, {"candidates": [{"finishReason": "STOP", "content": []}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": []}}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": [None]}}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": 123}]}}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "{}", "thought": "false"}]}}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"thought": True, "text": "{}"}]}}]},
    {"candidates": [{}] * 101},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": ""}] * 101}}]},
])
def test_malformed_envelopes(wrapped):
    with pytest.raises(HTTPException) as exc:
        recognize(provider(wrapped=wrapped))
    assert exc.value.status_code == 502
    assert KEY not in exc.value.detail


@pytest.mark.parametrize("raw", ["", " ", "```json\n{}\n```", "{", "null", "[]", "true", "NaN", "Infinity", "-Infinity",
                                  '{"lines":[],"warnings":[],"warnings":[]}', "[" * 1500 + "]" * 1500])
def test_strict_inner_json(raw):
    with pytest.raises(HTTPException) as exc:
        recognize(provider(wrapped=envelope(raw=raw)))
    assert exc.value.status_code == 502


@pytest.mark.parametrize("body", [b"", b"not JSON", b"\xff", b"null", b'{"candidates":[],"candidates":[]}', b'{"x":NaN}', b"[" * 1500 + b"]" * 1500])
def test_strict_outer_json(body):
    with pytest.raises(HTTPException) as exc:
        recognize(provider(handler=lambda request: httpx.Response(200, content=body)))
    assert exc.value.status_code == 502


@pytest.mark.parametrize("kind,path,bad", [
    ("handwriting", ("lines",), {}), ("handwriting", ("lines",), [LINE] * 101),
    ("handwriting", ("warnings",), ["x"] * 101), ("handwriting", ("warnings",), [False]),
    ("handwriting", ("lines", 0, "text"), "x" * 16001), ("handwriting", ("lines", 0, "latex"), "x" * 16001),
    ("handwriting", ("lines", 0, "text"), "\ud800"), ("handwriting", ("lines", 0, "text"), 123),
    ("handwriting", ("lines", 0, "legibility"), "correct"), ("handwriting", ("lines", 0, "ambiguities"), ["x"] * 101),
    ("handwriting", ("lines", 0, "ambiguities"), ["x" * 16001]), ("handwriting", ("warnings",), ["x" * 16001]),
    ("handwriting", ("lines", 0, "unexpected"), KEY), ("handwriting", ("unexpected",), KEY),
    ("worksheet", ("title",), "x" * 16001), ("worksheet", ("language",), 123),
    ("worksheet", ("questions",), [QUESTION] * 101), ("worksheet", ("questions", 0, "text"), None),
    ("worksheet", ("questions", 0, "label"), "x" * 16001), ("worksheet", ("questions", 0, "diagram_description"), "x" * 16001),
    ("worksheet", ("questions", 0, "ambiguities"), "guess"), ("worksheet", ("questions", 0, "id"), "spoofed-id"),
    ("worksheet", ("questions", 0, "reviewed"), True), ("worksheet", ("student_id",), 8),
])
def test_strict_document_bounds(kind, path, bad):
    value = copy.deepcopy(HANDWRITING if kind == "handwriting" else WORKSHEET)
    target: Any = value
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = bad
    with pytest.raises(HTTPException) as exc:
        recognize(provider(value), kind)
    assert exc.value.status_code == 502
    assert KEY not in exc.value.detail


@pytest.mark.parametrize("kind,value", [("handwriting", {"lines": []}), ("worksheet", {"title": "", "language": "", "questions": []})])
def test_missing_required_fields(kind, value):
    with pytest.raises(HTTPException) as exc:
        recognize(provider(value), kind)
    assert exc.value.status_code == 502


def test_exact_field_and_array_limits_are_accepted():
    value = {"lines": [{**LINE, "text": "x" * 16000, "ambiguities": ["x"] * 100}], "warnings": ["x"] * 100}
    assert recognize(provider(value))["lines"] == value["lines"]
    assert len(recognize(provider({"lines": [LINE] * 100, "warnings": []}))["lines"]) == 100


@pytest.mark.parametrize("kind", ["handwriting", "worksheet"])
@pytest.mark.parametrize("warnings", [[], [" "], ["Blank image"]])
def test_empty_documents_keep_review_state_and_warning(kind, warnings):
    value = {"lines": [], "warnings": warnings} if kind == "handwriting" else {
        "title": "", "language": "", "questions": [], "warnings": warnings}
    result = recognize(provider(value), kind)
    assert result["lines" if kind == "handwriting" else "questions"] == []
    assert result["needs_review"] is True
    assert any(w.strip() for w in result["warnings"])
    if warnings == ["Blank image"]:
        assert result["warnings"] == warnings


@pytest.mark.parametrize("status,expected", [(301, 502), (302, 502), (307, 502), (308, 502), (400, 502), (401, 502), (403, 502), (404, 502), (429, 429), (500, 502), (503, 502)])
def test_http_errors_are_sanitized_and_redirects_never_followed(status, expected):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, headers={"location": f"https://evil.test/{KEY}"}, text=KEY)

    with pytest.raises(HTTPException) as exc:
        recognize(provider(handler=handler))
    assert exc.value.status_code == expected
    assert KEY not in exc.value.detail
    assert len(calls) == 1


@pytest.mark.parametrize("error,status", [(httpx.ConnectError, 502), (httpx.ReadError, 502), (httpx.RemoteProtocolError, 502),
                                         (httpx.ReadTimeout, 504), (httpx.ConnectTimeout, 504)])
def test_transport_errors_are_sanitized(error, status):
    def handler(request):
        raise error(f"{KEY} at {request.url}", request=request)

    with pytest.raises(HTTPException) as exc:
        recognize(provider(handler=handler))
    assert exc.value.status_code == status
    assert KEY not in exc.value.detail
    assert capture._ACTIVE_CALLS._total == 0


class ByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.reads = 0
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    async def aclose(self):
        self.closed = True


@pytest.mark.parametrize("declared", [False, True])
def test_provider_size_bound_closes_stream_early(declared):
    stream = ByteStream([b"x" * 65536] * 100)
    headers = {"content-length": str(capture.MAX_PROVIDER_BYTES + 1)} if declared else {}
    with pytest.raises(HTTPException) as exc:
        recognize(provider(handler=lambda request: httpx.Response(200, headers=headers, stream=stream)))
    assert exc.value.status_code == 502
    assert stream.closed
    assert stream.reads == (0 if declared else capture.MAX_PROVIDER_BYTES // 65536 + 1)
    assert capture._ACTIVE_CALLS._total == 0


def test_provider_exact_byte_limit_accepted():
    raw = json.dumps(envelope()).encode()
    raw += b" " * (capture.MAX_PROVIDER_BYTES - len(raw))
    assert recognize(provider(handler=lambda request: httpx.Response(200, content=raw)))["lines"] == HANDWRITING["lines"]


@pytest.mark.parametrize("headers", [{"content-encoding": "gzip"}, {"content-length": "-1"}, {"content-length": "not-a-length"}])
def test_invalid_provider_headers_rejected_before_read(headers):
    stream = ByteStream([b"sensitive body"])
    with pytest.raises(HTTPException) as exc:
        recognize(provider(handler=lambda request: httpx.Response(200, headers=headers, stream=stream)))
    assert exc.value.status_code == 502
    assert stream.reads == 0
    assert stream.closed


def test_overall_provider_timeout_and_slot_cleanup(monkeypatch):
    monkeypatch.setattr(capture, "PROVIDER_TIMEOUT_SECONDS", 0.01)

    async def scenario():
        async def stalled(request):
            await asyncio.Event().wait()

        with pytest.raises(HTTPException) as exc:
            await provider(handler=stalled).recognize_document("handwriting", image(), student_id="7")
        assert exc.value.status_code == 504
        assert capture._ACTIVE_CALLS._total == 0
        assert capture._ACTIVE_CALLS._students == {}

    asyncio.run(scenario())


@pytest.mark.parametrize("path", ["/api/capture/config", "/api/recognize", "/api/recognize-worksheet"])
@pytest.mark.parametrize("cookie", [None, "invalid-cookie"])
def test_routes_require_authentication_before_provider(path, cookie):
    calls = []
    client = provider(handler=lambda request: calls.append(request))
    with TestClient(app_for(client)) as browser:
        if cookie:
            browser.cookies.set("math_tutor_session", cookie)
        response = browser.get(path) if path.endswith("config") else browser.post(path, json={"image": image()})
    assert_private(response, 401)
    assert calls == []


def test_config_only_exposes_booleans_and_limits(monkeypatch):
    for name in ("GEMINI_API_KEY", "ELEVENLABS_API_KEY", "FIRECRAWL_API_KEY"):
        monkeypatch.setenv(name, KEY)
    with TestClient(app_for()) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.get("/api/capture/config")
    assert_private(response)
    body = response.json()
    assert body["gemini_configured"] is True
    assert body["elevenlabs_configured"] is True
    assert body["firecrawl_configured"] is True
    assert body["max_image_bytes"] == body["max_audio_bytes"] == 6 * 1024 * 1024
    assert body["max_request_bytes"] == 9 * 1024 * 1024
    assert body["max_provider_bytes"] == 2 * 1024 * 1024
    assert body["max_active_per_student"] == 1
    assert body["max_active_per_process"] == 2
    assert body["model"] == capture.DEFAULT_MODEL


def test_unconfigured_capabilities_and_bad_model_are_private(monkeypatch):
    assert not capture.capture_config()["gemini_configured"]
    assert not capture.capture_config()["elevenlabs_configured"]
    assert not capture.capture_config()["firecrawl_configured"]
    app = app_for()
    monkeypatch.setenv("GEMINI_MODEL", f"../{KEY}")
    with TestClient(app) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        assert_private(browser.get("/api/capture/config"), 500)


@pytest.mark.parametrize("headers", [
    {"origin": "https://evil.test"}, {"origin": "null"}, {"origin": "https://testserver"},
    {"origin": "http://testserver:81"}, {"origin": "http://testserver/"}, {"origin": "http://testserver/path"},
    {"origin": "http://testserver:0"}, {"origin": "http://testserver:"}, {"origin": "http://testserver?"},
    {"origin": "http://testserver#"},
    {"origin": "http://user@testserver"}, {"origin": "http://testserver?query=x"},
    {"origin": "http://testserver#fragment"}, {"origin": "http://testserver.evil.test"},
    {"origin": "http://testserver http://evil.test"}, {"origin": "http://testserver:bad"},
    {"sec-fetch-site": "cross-site"}, {"origin": "http://testserver", "sec-fetch-site": "cross-site"},
    [("origin", "http://testserver"), ("origin", "http://evil.test")],
])
@pytest.mark.parametrize("path", ["/api/capture/config", "/api/recognize", "/api/recognize-worksheet"])
def test_cross_origin_requests_rejected_before_auth(headers, path):
    auth_calls = []

    def forbidden_auth(token):
        auth_calls.append(token)
        return {"id": 7}

    with TestClient(app_for(auth=forbidden_auth)) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.get(path, headers=headers) if path.endswith("config") else browser.post(path, headers=headers, json={"image": image()})
    assert_private(response, 403)
    assert auth_calls == []


@pytest.mark.parametrize("headers", [{}, {"origin": "http://testserver"}, {"origin": "http://TESTSERVER:80"},
                                     {"origin": "http://testserver", "sec-fetch-site": "same-origin"}])
def test_same_origin_or_nonbrowser_allowed(headers):
    with TestClient(app_for()) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.post("/api/recognize", headers=headers, json={"image": image()})
    assert_private(response)


@pytest.mark.parametrize("path,kind,value", [("/api/recognize", "handwriting", HANDWRITING), ("/api/recognize-worksheet", "worksheet", WORKSHEET)])
def test_routes_return_only_current_response_no_shared_results(path, kind, value):
    with TestClient(app_for(provider(value))) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        first = browser.post(path, json={"image": image()})
        browser.cookies.set("math_tutor_session", "student-two")
        second = browser.post(path, json={"image": image(JPEG, "image/jpeg")})
    assert_private(first)
    assert_private(second)
    assert first.json()["recognition_id"] != second.json()["recognition_id"]
    assert "student_id" not in first.json()
    if kind == "worksheet":
        assert first.json()["questions"][0]["id"] != second.json()["questions"][0]["id"]
        assert second.json()["questions"][0]["reviewed"] is False


@pytest.mark.parametrize("payload", [None, [], {}, {"image": 123}, {"image": None}, {"image": ""},
                                    {"image": image(), "student_id": 8}, {"image": image(), "recognition_id": "spoofed"},
                                    {"image": image(), "api_key": KEY}, {"image": image(), "model": "evil"},
                                    {"image": image(), "sessionId": "someone-else"}])
def test_request_schema_and_ownership_fields_rejected(payload):
    with TestClient(app_for()) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.post("/api/recognize", content=json.dumps(payload), headers={"content-type": "application/json"})
    assert_private(response, 400)
    assert image() not in response.text


@pytest.mark.parametrize("body,headers,status", [
    (b"{}", {"content-type": "text/plain"}, 415),
    (b"{}", {"content-type": "application/json", "content-encoding": "gzip"}, 415),
    (b"{", {"content-type": "application/json"}, 400),
    (b"\xff", {"content-type": "application/json"}, 400),
    (b'{"image":"a","image":"b"}', {"content-type": "application/json"}, 400),
    (b'{"image":NaN}', {"content-type": "application/json"}, 400),
    (b"{}", {"content-type": "application/json", "content-length": "-1"}, 400),
    (b"{}", {"content-type": "application/json", "content-length": "10"}, 400),
    (b"{}", {"content-type": "application/json", "content-length": str(capture.MAX_REQUEST_BYTES + 1)}, 413),
])
def test_bad_request_bodies_are_private(body, headers, status):
    with TestClient(app_for()) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.post("/api/recognize", content=body, headers=headers)
    assert_private(response, status)


@pytest.mark.parametrize("status,expected", [(200, 502), (429, 429), (500, 502)])
def test_route_provider_errors_are_private(status, expected):
    client = provider(handler=lambda request: httpx.Response(status, text=KEY))
    with TestClient(app_for(client)) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.post("/api/recognize", json={"image": image()})
    assert_private(response, expected)


def test_unexpected_errors_and_auth_details_are_not_exposed():
    def broken_auth(token):
        raise RuntimeError(KEY + COOKIE)

    with TestClient(app_for(auth=broken_auth)) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        assert_private(browser.get("/api/capture/config"), 500)


@pytest.mark.parametrize("learner", [None, {}, {"id": None}, {"id": True}, {"id": []}, {"id": ""}])
def test_auth_must_provide_stable_student_id(learner):
    with TestClient(app_for(auth=lambda token: learner)) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        assert_private(browser.get("/api/capture/config"), 401)


def test_async_auth_and_sqlite_row_contract():
    async def async_auth(token):
        assert token == COOKIE
        return {"id": "student-uuid"}

    with TestClient(app_for(auth=async_auth)) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        assert_private(browser.get("/api/capture/config"))
    with sqlite3.connect(":memory:") as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT 7 AS id").fetchone()
    with TestClient(app_for(auth=lambda token: row)) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        assert_private(browser.get("/api/capture/config"))


def test_request_body_bound_without_content_length(monkeypatch):
    monkeypatch.setattr(capture, "MAX_REQUEST_BYTES", 100)

    async def scenario():
        reads = 0

        async def body():
            nonlocal reads
            for _ in range(10):
                reads += 1
                yield b"x" * 60

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_for()), base_url="http://testserver") as browser:
            response = await browser.post("/api/recognize", headers={"cookie": f"math_tutor_session={COOKIE}", "content-type": "application/json"}, content=body())
        assert_private(response, 413)
        assert reads == 2

    asyncio.run(scenario())


def test_body_not_read_before_authentication():
    async def scenario():
        async def body():
            pytest.fail("Unauthenticated body was consumed")
            yield b""

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_for()), base_url="http://testserver") as browser:
            response = await browser.post("/api/recognize", headers={"content-type": "application/json"}, content=body())
        assert_private(response, 401)

    asyncio.run(scenario())


def test_streamed_body_timeout(monkeypatch):
    monkeypatch.setattr(capture, "BODY_TIMEOUT_SECONDS", 0.01)

    async def scenario():
        async def body():
            await asyncio.Event().wait()
            yield b""

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_for()), base_url="http://testserver") as browser:
            response = await browser.post("/api/recognize", headers={"cookie": f"math_tutor_session={COOKIE}", "content-type": "application/json"}, content=body())
        assert_private(response, 408)

    asyncio.run(scenario())


def test_concurrency_is_student_scoped_and_shared_across_routers():
    async def scenario():
        entered = asyncio.Queue()
        release = asyncio.Event()
        calls = 0

        async def handler(request):
            nonlocal calls
            calls += 1
            await entered.put(None)
            await release.wait()
            return httpx.Response(200, json=envelope())

        first_app = app_for(provider(handler=handler))
        other_app = app_for(provider(handler=handler))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=first_app), base_url="http://testserver") as first_browser, \
                httpx.AsyncClient(transport=httpx.ASGITransport(app=other_app), base_url="http://testserver") as other_browser:
            async def post(browser, token):
                return await browser.post("/api/recognize", json={"image": image()}, headers={"cookie": f"math_tutor_session={token}"})

            task_one = asyncio.create_task(post(first_browser, COOKIE))
            await asyncio.wait_for(entered.get(), timeout=2)
            task_two = None
            try:
                # A second session for the SAME student cannot bypass the per-student limit.
                assert_private(await post(other_browser, "same-student-second-session"), 429)
                task_two = asyncio.create_task(post(other_browser, "student-two"))
                await asyncio.wait_for(entered.get(), timeout=2)
                # A third student cannot bypass the shared process limit via another router.
                assert_private(await post(first_browser, "student-three"), 429)
                assert calls == 2
            finally:
                release.set()
                assert_private(await task_one)
                if task_two is not None:
                    assert_private(await task_two)
            assert_private(await post(first_browser, "student-three"))
        assert capture._ACTIVE_CALLS._total == 0
        assert capture._ACTIVE_CALLS._students == {}

    asyncio.run(scenario())


def test_cancellation_releases_student_and_process_slots():
    async def scenario():
        entered = asyncio.Event()

        async def handler(request):
            entered.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(provider(handler=handler).recognize_document("handwriting", image(), student_id="7"))
        await asyncio.wait_for(entered.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert capture._ACTIVE_CALLS._total == 0
        assert capture._ACTIVE_CALLS._students == {}
        assert (await provider().recognize_document("handwriting", image(), student_id="7"))["lines"] == HANDWRITING["lines"]

    asyncio.run(scenario())


def test_mismatched_provider_content_length():
    raw = json.dumps(envelope()).encode()
    client = provider(handler=lambda request: httpx.Response(200, content=raw, headers={"content-length": str(len(raw) + 1)}))
    with pytest.raises(HTTPException) as exc:
        recognize(client)
    assert exc.value.status_code == 502


@pytest.mark.parametrize("bad_response", [httpx.Response(429, text=KEY), httpx.Response(200, text=KEY)])
def test_failed_calls_allow_same_student_to_retry(bad_response):
    async def scenario():
        with pytest.raises(HTTPException):
            await provider(handler=lambda request: bad_response).recognize_document("handwriting", image(), student_id="7")
        assert capture._ACTIVE_CALLS._total == 0
        assert capture._ACTIVE_CALLS._students == {}
        assert (await provider().recognize_document("handwriting", image(), student_id="7"))["needs_review"] is True

    asyncio.run(scenario())


def test_route_input_size_errors_are_no_store():
    calls = []
    client = provider(handler=lambda request: calls.append(request))
    with TestClient(app_for(client)) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        data = "data:image/png;base64," + "A" * (capture.MAX_BASE64_LENGTH + 4)
        response = browser.post("/api/recognize", json={"image": data})
    assert_private(response, 413)
    assert calls == []


def test_exact_request_body_limit():
    raw = json.dumps({"image": image()}).encode()
    raw += b" " * (capture.MAX_REQUEST_BYTES - len(raw))
    with TestClient(app_for()) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.post("/api/recognize", content=raw, headers={"content-type": "application/json"})
    assert_private(response)


def test_route_provider_timeout_is_no_store():
    def timed_out(request):
        raise httpx.ReadTimeout(KEY, request=request)

    with TestClient(app_for(provider(handler=timed_out))) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.post("/api/recognize", json={"image": image()})
    assert_private(response, 504)


def test_default_router_without_key_is_private_and_never_connects():
    app = FastAPI()
    app.include_router(capture.create_capture_router(authenticate))
    with TestClient(app) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        response = browser.post("/api/recognize", json={"image": image()})
    assert_private(response, 503)


def test_auth_forbidden_details_remain_private():
    def forbidden(token):
        raise HTTPException(403, KEY + COOKIE)

    with TestClient(app_for(auth=forbidden)) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        assert_private(browser.get("/api/capture/config"), 403)


def test_results_cannot_be_retrieved_by_another_student():
    with TestClient(app_for()) as browser:
        browser.cookies.set("math_tutor_session", COOKIE)
        first = browser.post("/api/recognize", json={"image": image()})
        assert_private(first)
        browser.cookies.set("math_tutor_session", "student-two")
        # There is no global results cache or retrieval endpoint to leak prior work.
        response = browser.get(f"/api/recognize/{first.json()['recognition_id']}")
        assert response.status_code == 404
        assert LINE["text"] not in response.text


def test_https_default_port_and_reverse_proxy_root_path():
    async def scenario():
        app = app_for()
        transport = httpx.ASGITransport(app=app, root_path="/tutor")
        async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as browser:
            headers = {"cookie": f"math_tutor_session={COOKIE}", "origin": "https://testserver:443"}
            assert_private(await browser.get("/api/capture/config", headers=headers))
            headers["origin"] = "http://testserver"
            assert_private(await browser.get("/api/capture/config", headers=headers), 403)

    asyncio.run(scenario())