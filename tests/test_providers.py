"""Existing voice/URL routes, real parsers, and offline streamed provider mocks."""
import asyncio
import base64
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

import main
import math_capture


SECRET = "provider-secret-must-not-appear"
AUDIO = "data:audio/webm;base64,GkXfow=="
LINE = {"text": "2 + 2 = 5", "latex": "2+2=5", "ambiguities": ["5 or S"]}
QUESTION = {"label": "1(a)", **LINE, "diagram_description": "Un triangle de côtés 3, 4 et 5."}
PAGE = {"title": "Géométrie", "language": "fr", "lesson_context": "Les triangles.", "questions": [QUESTION], "warnings": []}
ROUTES = ["/voice/transcribe", "/voice/math-json", "/import-problem-url"]
BODIES = [{"audioData": AUDIO}, {"transcript": "two plus two equals five"}, {"url": "https://lessons.example.org/math#q1"}]
REAL_ASYNC_CLIENT = httpx.AsyncClient


@pytest.fixture
def learner(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATABASE_PATH", tmp_path / "providers.sqlite3")
    main.initialize_database()
    client = TestClient(main.app)
    assert client.post("/auth/register", json={
        "fullName": "Provider Student", "email": f"{uuid4()}@example.test", "password": "test-password",
        "grade": 8, "country": "United States", "state": "Oregon",
    }).status_code == 201
    for name in ("GEMINI_API_KEY", "ELEVENLABS_API_KEY", "FIRECRAWL_API_KEY"):
        monkeypatch.setenv(name, SECRET)
    return client


def gemini(value=None, reason="STOP"):
    return {"candidates": [{"finishReason": reason, "content": {"parts": [
        {"text": json.dumps(value if value is not None else {"lines": [LINE], "warnings": []})}
    ]}}]}


def firecrawl(value=None):
    return {"success": True, "data": {"json": PAGE if value is None else value, "metadata": {"statusCode": 200}}}


def mock_provider(monkeypatch, handler):
    calls = []

    async def handle(request):
        calls.append(request)
        result = handler(request)
        return await result if hasattr(result, "__await__") else result

    def client(**kwargs):
        assert kwargs.get("follow_redirects") is False
        assert kwargs.get("trust_env") is False
        kwargs["transport"] = httpx.MockTransport(handle)
        return REAL_ASYNC_CLIENT(**kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    return calls


def private(response, status=200):
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    assert SECRET not in response.text
    return response.json()


def test_firecrawl_preserves_node_questions_language_and_legacy_lines(learner, monkeypatch):
    calls = mock_provider(monkeypatch, lambda _: httpx.Response(200, json=firecrawl()))
    result = private(learner.post(ROUTES[2], json=BODIES[2]))
    assert result["questions"] == [QUESTION]
    assert result["lines"] == [LINE]
    assert result["language"] == "fr"
    assert result["sourceUrl"] == "https://lessons.example.org/math"
    assert result["lessonContext"] == PAGE["lesson_context"]
    assert result["needsReview"] is True and result["provider"] == "Firecrawl"
    assert len(calls) == 1
    request = calls[0]
    assert str(request.url) == "https://api.firecrawl.dev/v2/scrape"
    assert request.headers["authorization"] == f"Bearer {SECRET}"
    body = json.loads(request.content)
    assert set(body) == {"url", "onlyMainContent", "timeout", "formats"}
    assert body["onlyMainContent"] is True and body["timeout"] == 60000
    schema = body["formats"][0]["schema"]
    assert schema["properties"]["questions"]["maxItems"] == 12
    prompt = body["formats"][0]["prompt"]
    for fragment in ("untrusted", "do not", "diagrams", "answers", "personal"):
        assert fragment in prompt.lower()
    # Five question fields can be saved unchanged after explicit user review.
    notebook = private(learner.post("/api/notebooks", json={"title": result["title"], "sourceType": "url",
        "sourceUrl": result["sourceUrl"], "questions": result["questions"], "reviewed": True}), 201)
    session = private(learner.post(f"/api/notebooks/{notebook['id']}/questions/0/practice"), 201)
    assert session["imported"] is True
    raw = "  2 + 2 = 5\n\\text{not corrected}  "
    saved = private(learner.post(f"/learning-sessions/{session['sessionId']}/steps",
                               json={"rawLatex": raw, "confidence": 1, "timestamp": 1}))
    assert saved["saved"] is True and saved["assessment"] == "ungraded"
    review = private(learner.get(f"/learning-sessions/{session['sessionId']}/review"))
    assert review["assessment"] == "ungraded" and review["complete"] is False
    assert review["findings"][0]["rawLatex"] == raw
    assert len(calls) == 1  # Saving/practicing/reviewing must not call any provider.


def test_legacy_firecrawl_lines_are_promoted_without_inventing_diagrams(learner, monkeypatch):
    mock_provider(monkeypatch, lambda _: httpx.Response(200, json=firecrawl({
        "title": "Legacy", "lesson_context": "", "lines": [LINE], "warnings": []})))
    result = private(learner.post(ROUTES[2], json=BODIES[2]))
    assert result["lines"] == [LINE]
    assert result["questions"] == [{"label": "", **LINE, "diagram_description": ""}]
    assert result.get("language") is None


@pytest.mark.parametrize("context,status", [("Relevant lesson without exercises.", 200), (" ", 422)])
def test_context_only_firecrawl_lessons(learner, monkeypatch, context, status):
    mock_provider(monkeypatch, lambda _: httpx.Response(200, json=firecrawl({**PAGE, "questions": [], "lesson_context": context})))
    result = private(learner.post(ROUTES[2], json=BODIES[2]), status)
    if status == 200:
        assert result["lines"] == result["questions"] == []
        assert result["warnings"] and result["needsReview"] is True


def test_scribe_contract_and_math_conversion_preserve_incorrect_math(learner, monkeypatch):
    def handler(request):
        assert request.headers["accept-encoding"] == "identity"
        if request.url.host == "api.elevenlabs.io":
            assert request.url.path == "/v1/speech-to-text"
            assert request.headers["xi-api-key"] == SECRET
            assert b"scribe_v2" in request.content and b"formula.webm" in request.content
            assert b"\x1a\x45\xdf\xa3" in request.content
            assert b'name="diarize"\r\n\r\nfalse' in request.content
            return httpx.Response(200, json={"text": " two plus two equals five ", "words": [], "private": SECRET})
        assert request.url.query == b"" and request.headers["x-goog-api-key"] == SECRET
        body = json.loads(request.content)
        prompt = body["systemInstruction"]["parts"][0]["text"]
        assert "untrusted" in prompt and "do not solve" in prompt
        assert body["contents"][0]["parts"][0]["text"] == "two plus two equals five"
        value = gemini()
        value["candidates"][0]["content"]["parts"].insert(0, {"thought": True, "text": SECRET})
        return httpx.Response(200, json=value)

    calls = mock_provider(monkeypatch, handler)
    transcript = private(learner.post(ROUTES[0], json=BODIES[0]))
    assert transcript == {"transcript": "two plus two equals five", "provider": "ElevenLabs Scribe", "needsReview": True}
    result = private(learner.post(ROUTES[1], json={"transcript": transcript["transcript"]}))
    assert result["lines"] == [LINE] and result["needsReview"] is True
    assert len(calls) == 2


@pytest.mark.parametrize("index", range(3))
@pytest.mark.parametrize("status,expected", [(302, 502), (307, 502), (401, 502), (402, 502), (429, 429), (500, 502)])
def test_provider_failures_never_echo_body_credentials_or_follow_redirect(learner, monkeypatch, index, status, expected):
    calls = mock_provider(monkeypatch, lambda _: httpx.Response(status, text=SECRET, headers={"location": f"https://other.example.org/{SECRET}"}))
    private(learner.post(ROUTES[index], json=BODIES[index]), expected)
    assert len(calls) == 1
    assert math_capture._ACTIVE_CALLS._total == 0


@pytest.mark.parametrize("index", range(3))
@pytest.mark.parametrize("error,status", [(httpx.ReadTimeout, 504), (httpx.ConnectError, 502), (httpx.RemoteProtocolError, 502)])
def test_provider_transport_errors_are_sanitized(learner, monkeypatch, index, error, status):
    def fail(request):
        raise error(SECRET, request=request)

    mock_provider(monkeypatch, fail)
    private(learner.post(ROUTES[index], json=BODIES[index]), status)
    assert math_capture._ACTIVE_CALLS._total == 0


@pytest.mark.parametrize("index", range(3))
@pytest.mark.parametrize("body", [b"null", b"[]", b"not JSON", b"\xff", b'{"text":"a","text":"b"}', b'{"text":NaN}'])
def test_provider_json_is_strict(learner, monkeypatch, index, body):
    mock_provider(monkeypatch, lambda _: httpx.Response(200, content=body))
    private(learner.post(ROUTES[index], json=BODIES[index]), 502)


@pytest.mark.parametrize("patch", [
    {"title": 12}, {"language": []}, {"lesson_context": "x" * 16001}, {"warnings": "bad"}, {"warnings": [False]},
    {"questions": [QUESTION] * 13}, {"questions": [{**QUESTION, "diagram_description": "x" * 16001}]},
    {"questions": [{**QUESTION, "ambiguities": [False]}]}, {"questions": [{**QUESTION, "reviewed": True}]},
    {"questions": [{**QUESTION, "text": " ", "latex": " "}]}, {"questions": [{**QUESTION, "text": "\ud800"}]},
    {"lines": [{**LINE, "latex": "not the same"}]},
])
def test_firecrawl_invalid_extractions_are_not_coerced_or_truncated(learner, monkeypatch, patch):
    raw = json.dumps(firecrawl({**PAGE, **patch})).encode()
    mock_provider(monkeypatch, lambda _: httpx.Response(200, content=raw))
    private(learner.post(ROUTES[2], json=BODIES[2]), 502)


@pytest.mark.parametrize("value", [{}, {"success": False, "data": {"json": PAGE}},
    {"success": True, "data": {"json": PAGE, "metadata": {"statusCode": 404}}},
    {"success": True, "data": {"json": PAGE, "metadata": {"statusCode": "200"}}}])
def test_firecrawl_rejects_failure_and_error_pages(learner, monkeypatch, value):
    mock_provider(monkeypatch, lambda _: httpx.Response(200, json=value))
    private(learner.post(ROUTES[2], json=BODIES[2]), 502)


@pytest.mark.parametrize("value", [gemini(reason="MAX_TOKENS"), gemini(reason="SAFETY"), gemini(reason=None),
    gemini({"lines": [LINE] * 13, "warnings": []}), gemini({"lines": [LINE], "warnings": [12]}),
    gemini({"lines": [{**LINE, "text": "x" * 16001}], "warnings": []})])
def test_spoken_math_rejects_incomplete_or_invalid_documents(learner, monkeypatch, value):
    mock_provider(monkeypatch, lambda _: httpx.Response(200, json=value))
    private(learner.post(ROUTES[1], json=BODIES[1]), 502)


@pytest.mark.parametrize("text,status", [(False, 502), ("x" * 16001, 502), ("\ud800", 502), (" ", 422)],
                         ids=["wrong-type", "oversized", "surrogate", "no-speech"])
def test_scribe_validates_transcript_before_returning(learner, monkeypatch, text, status):
    mock_provider(monkeypatch, lambda _: httpx.Response(200, content=json.dumps({"text": text}).encode()))
    private(learner.post(ROUTES[0], json=BODIES[0]), status)


@pytest.mark.parametrize("index,body", [(0, {"audioData": "data:audio/webm;base64,aGVsbG8="}),
    (0, {"audioData": "data:audio/webm;base64,GkXfow="}), (0, {"audioData": "data:audio/webm;base64,GkXfox=="}),
    (1, {"transcript": " "}), (1, {"transcript": "\ud800"}), (1, {"transcript": "hello", "apiKey": SECRET}),
    (2, {"url": "https://example.org:bad/private"}), (2, {"url": "https://example.org/q?api_key=" + SECRET}),
    (2, {"url": "https://example.org/", "headers": {"Authorization": SECRET}})])
def test_bad_inputs_are_sanitized_before_network(learner, monkeypatch, index, body):
    calls = mock_provider(monkeypatch, lambda _: pytest.fail("Invalid input reached provider"))
    private(learner.post(ROUTES[index], content=json.dumps(body), headers={"content-type": "application/json"}), 422)
    assert calls == []


@pytest.mark.parametrize("data,mime,extension", [(b"\x1aE\xdf\xa3", "webm", "webm"), (b"OggS", "ogg", "ogg"),
    (b"0000ftyp", "mp4", "m4a"), (b"ID3", "mpeg", "mp3"), (b"\xff\xfb", "mpeg", "mp3"),
    (b"RIFF0000WAVE", "wav", "wav"), (b"RIFF0000WAVE", "x-wav", "wav")])
def test_audio_signatures_follow_node_contract(data, mime, extension):
    audio = f"data:audio/{mime};base64,{base64.b64encode(data).decode()}"
    assert main.decode_voice_audio(audio) == (data, f"audio/{mime}", extension)


class Stream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks, self.reads, self.closed = chunks, 0, False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    async def aclose(self):
        self.closed = True


@pytest.mark.parametrize("index", range(3))
@pytest.mark.parametrize("headers", [{}, {"content-length": str(math_capture.MAX_PROVIDER_BYTES + 1)},
    {"content-length": "bad"}, {"content-encoding": "gzip"}])
def test_provider_streams_are_bounded_and_closed(learner, monkeypatch, index, headers):
    stream = Stream([b"x" * 65536] * 100)
    mock_provider(monkeypatch, lambda _: httpx.Response(200, stream=stream, headers=headers))
    private(learner.post(ROUTES[index], json=BODIES[index]), 502)
    assert stream.closed
    assert stream.reads == (0 if headers else math_capture.MAX_PROVIDER_BYTES // 65536 + 1)
    assert math_capture._ACTIVE_CALLS._total == 0


def test_imported_review_returns_all_raw_steps_even_if_legacy_status_was_correct(learner):
    notebook = private(learner.post("/api/notebooks", json={"title": "Raw steps", "sourceType": "manual",
        "questions": [QUESTION], "reviewed": True}), 201)
    session = private(learner.post(f"/api/notebooks/{notebook['id']}/questions/0/practice"), 201)
    with main.database_connection() as db:
        db.execute("INSERT INTO practice_steps (practice_session_id, step_index, raw_latex, status, error_type, created_at) VALUES (?, 0, ?, 'correct', NULL, 1)",
                   (session["sessionId"], "  raw saved step  "))
    result = private(learner.get(f"/learning-sessions/{session['sessionId']}/review"))
    assert result["assessment"] == "ungraded"
    assert [finding["rawLatex"] for finding in result["findings"]] == ["  raw saved step  "]


@pytest.mark.parametrize("index", range(3))
def test_overall_deadlines_bound_stalled_providers_and_release_slots(learner, monkeypatch, index):
    monkeypatch.setattr(main, "VOICE_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(main, "FIRECRAWL_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(math_capture, "PROVIDER_TIMEOUT_SECONDS", 0.01)
    cancelled = []

    async def stalled(request):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)

    mock_provider(monkeypatch, stalled)
    private(learner.post(ROUTES[index], json=BODIES[index]), 504)
    assert cancelled == [True]
    assert math_capture._ACTIVE_CALLS._total == 0
    assert math_capture._ACTIVE_CALLS._students == {}


def test_voice_url_and_capture_share_student_and_process_concurrency_limits(learner, monkeypatch):
    students = [learner]
    for _ in range(2):
        client = TestClient(main.app)
        assert client.post("/auth/register", json={"fullName": "Concurrent Student", "email": f"{uuid4()}@example.test",
            "password": "test-password", "grade": 8, "country": "United States", "state": "Oregon"}).status_code == 201
        students.append(client)

    async def scenario():
        entered, release = asyncio.Queue(), asyncio.Event()

        async def handler(request):
            await entered.put(None)
            await release.wait()
            return httpx.Response(200, json=firecrawl() if request.url.host == "api.firecrawl.dev" else {"text": "two plus two"})

        calls = mock_provider(monkeypatch, handler)
        async with REAL_ASYNC_CLIENT(transport=httpx.ASGITransport(app=main.app), base_url="http://testserver") as browser:
            async def post(index, student=0):
                return await browser.post(ROUTES[index], json=BODIES[index],
                    headers={"cookie": f"math_tutor_session={students[student].cookies.get('math_tutor_session')}"})

            first = asyncio.create_task(post(0))
            second = None
            try:
                await asyncio.wait_for(entered.get(), 2)
                private(await post(1), 429)
                private(await post(2), 429)
                private(await browser.post("/api/recognize-worksheet", json={"image": "data:image/png;base64,iVBORw0KGgo="},
                    headers={"cookie": f"math_tutor_session={learner.cookies.get('math_tutor_session')}"}), 429)
                second = asyncio.create_task(post(2, 1))
                await asyncio.wait_for(entered.get(), 2)
                private(await post(0, 2), 429)
                assert len(calls) == 2
            finally:
                release.set()
                private(await first)
                if second is not None:
                    private(await second)
        assert math_capture._ACTIVE_CALLS._total == 0
        assert math_capture._ACTIVE_CALLS._students == {}

    asyncio.run(scenario())


def test_cancelled_voice_request_releases_shared_slot(learner, monkeypatch):
    async def scenario():
        entered = asyncio.Event()

        async def handler(request):
            entered.set()
            await asyncio.Event().wait()

        mock_provider(monkeypatch, handler)
        async with REAL_ASYNC_CLIENT(transport=httpx.ASGITransport(app=main.app), base_url="http://testserver") as browser:
            task = asyncio.create_task(browser.post(ROUTES[0], json=BODIES[0],
                headers={"cookie": f"math_tutor_session={learner.cookies.get('math_tutor_session')}"}))
            try:
                await asyncio.wait_for(entered.wait(), 2)
            finally:
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
        assert math_capture._ACTIVE_CALLS._total == 0
        assert math_capture._ACTIVE_CALLS._students == {}

    asyncio.run(scenario())


@pytest.mark.parametrize("index,payload", [(0, {"text": "a" * 16000}),
    (1, gemini({"lines": [LINE] * 12, "warnings": ["?"] * 100})),
    (2, firecrawl({**PAGE, "questions": [QUESTION] * 12}))])
def test_exact_provider_byte_and_document_limits_are_accepted(learner, monkeypatch, index, payload):
    raw = json.dumps(payload).encode()
    raw += b" " * (math_capture.MAX_PROVIDER_BYTES - len(raw))
    calls = mock_provider(monkeypatch, lambda _: httpx.Response(200, content=raw))
    private(learner.post(ROUTES[index], json=BODIES[index]))
    assert len(calls) == 1


@pytest.mark.parametrize("index", range(3))
def test_provider_incomplete_content_length_is_rejected(learner, monkeypatch, index):
    stream = Stream([b"{}"])
    mock_provider(monkeypatch, lambda _: httpx.Response(200, stream=stream, headers={"content-length": "10"}))
    private(learner.post(ROUTES[index], json=BODIES[index]), 502)
    assert stream.closed


@pytest.mark.parametrize("url", ["https://0x7f.0.0.0x1/q", "https://example.org:bad/", "https://example.org/\ud800",
    "https://example.org/\x7f", "https://example.org/" + "x" * 2049], ids=["hex-ip", "bad-port", "surrogate", "control", "oversized"])
def test_public_source_url_validation_rejects_ambiguous_hosts_and_unsafe_text(url):
    with pytest.raises(ValueError):
        main.public_lesson_url(url)


def test_audio_byte_limits_and_codec_parameter(monkeypatch):
    data = b"\x1aE\xdf\xa3" + b"x" * (main.MAX_VOICE_AUDIO_BYTES - 4)
    audio = "data:audio/webm;codecs=opus;base64," + base64.b64encode(data).decode()
    assert main.decode_voice_audio(audio)[0] == data
    with pytest.raises(ValueError):
        main.decode_voice_audio("data:audio/webm;base64," + base64.b64encode(data + b"x").decode())
    monkeypatch.setattr(main, "b64decode", lambda *a, **kw: pytest.fail("Oversized input was decoded"))
    with pytest.raises(ValueError):
        main.decode_voice_audio("x" * (8_400_001))


def test_empty_spoken_math_stays_reviewable_with_a_warning(learner, monkeypatch):
    mock_provider(monkeypatch, lambda _: httpx.Response(200, json=gemini({"lines": [], "warnings": []})))
    result = private(learner.post(ROUTES[1], json=BODIES[1]))
    assert result["lines"] == [] and result["warnings"] and result["needsReview"] is True


@pytest.mark.parametrize("model", ["../private", "x" * 129, "gemini?key=private"])
def test_invalid_gemini_model_never_reaches_provider(learner, monkeypatch, model):
    monkeypatch.setenv("GEMINI_MODEL", model)
    calls = mock_provider(monkeypatch, lambda _: pytest.fail("Invalid model reached provider"))
    private(learner.post(ROUTES[1], json=BODIES[1]), 500)
    assert calls == []