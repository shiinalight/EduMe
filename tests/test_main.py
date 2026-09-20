import secrets

import pytest
from fastapi.testclient import TestClient

from main import app, database_connection, decode_voice_audio, practice_problem, public_lesson_url


pytestmark = pytest.mark.usefixtures("clean_database")
client = TestClient(app)


def test_root_confirms_service_is_running():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_voice_audio_and_public_lesson_inputs_are_bounded_before_providers_are_called():
    audio_bytes, mime_type, extension = decode_voice_audio("data:audio/webm;base64,GkXfow==")
    assert audio_bytes == bytes([0x1A, 0x45, 0xDF, 0xA3])
    assert (mime_type, extension) == ("audio/webm", "webm")
    assert public_lesson_url("https://lessons.example.org/topic#skip-this") == "https://lessons.example.org/topic"
    try:
        public_lesson_url("http://127.0.0.1/private-lesson")
    except ValueError as error:
        assert "public website" in str(error)
    else:
        raise AssertionError("Local lesson URLs must be rejected.")


def test_voice_and_link_import_routes_require_configured_server_keys(monkeypatch):
    learner = TestClient(app)
    learner.post(
        "/auth/register",
        json={
            "fullName": "Voice Student",
            "email": f"voice-{secrets.token_hex(6)}@example.test",
            "password": "safe-practice-password",
            "grade": 8,
            "country": "United States",
            "state": "Oregon",
        },
    )
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("FIRECRAWL_API_KEY", raising=False)
    assert learner.post("/voice/math-json", json={"transcript": "three squared plus four squared"}).status_code == 503
    assert learner.post("/import-problem-url", json={"url": "https://lessons.example.org/triangle"}).status_code == 503


def test_tablet_frontend_is_served():
    response = client.get("/app/")
    assert response.status_code == 200
    assert "Write with Apple Pencil" in response.text


def test_ocr_provider_list_keeps_local_and_team_options(monkeypatch):
    monkeypatch.delenv("TEAM_OCR_URL", raising=False)
    monkeypatch.delenv("OCR_SERVICE_URL", raising=False)
    providers = client.get("/ocr-providers").json()
    assert [provider["id"] for provider in providers] == ["local-pix2tex", "team-ocr", "inkmath"]
    assert providers[1]["configured"] is False


def test_default_ocr_provider_is_local_unless_configured(monkeypatch):
    monkeypatch.delenv("DEFAULT_OCR_PROVIDER", raising=False)
    assert client.get("/ocr-default").json()["providerId"] == "inkmath"
    monkeypatch.setenv("DEFAULT_OCR_PROVIDER", "team-ocr")
    assert client.get("/ocr-default").json()["providerId"] == "team-ocr"


def test_recognizer_explains_when_no_provider_is_configured(monkeypatch):
    monkeypatch.delenv("OCR_SERVICE_URL", raising=False)
    monkeypatch.setenv("PIX2TEX_URL", "http://127.0.0.1:9/predict/")
    learner = authenticated_ocr_client()
    response = learner.post(
        "/recognize-handwriting",
        json={"imageData": "data:image/png;base64," + "A" * 30, "sessionId": "abc123", "stepIndex": 0},
    )
    assert response.status_code == 503


def test_team_recognizer_requires_its_own_configuration(monkeypatch):
    monkeypatch.delenv("TEAM_OCR_URL", raising=False)
    monkeypatch.delenv("OCR_SERVICE_URL", raising=False)
    learner = authenticated_ocr_client()
    response = learner.post(
        "/recognize-handwriting",
        json={
            "imageData": "data:image/png;base64," + "QUFBQQ==",
            "sessionId": "abc123",
            "stepIndex": 0,
            "providerId": "team-ocr",
        },
    )
    assert response.status_code == 503
    assert "TEAM_OCR_URL" in response.json()["detail"]


def authenticated_ocr_client():
    learner = TestClient(app)
    response = learner.post("/auth/register", json={
        "fullName": "OCR Student", "email": f"ocr-{secrets.token_hex(6)}@example.test",
        "password": "safe-practice-password", "grade": 8, "country": "United States", "state": "Oregon",
    })
    assert response.status_code == 201
    return learner


def test_student_profile_generates_and_checks_a_persisted_learning_session():
    learner = TestClient(app)
    email = f"learner-{secrets.token_hex(6)}@example.test"
    registered = learner.post(
        "/auth/register",
        json={
            "fullName": "Avery Student",
            "email": email,
            "password": "safe-practice-password",
            "grade": 7,
            "country": "United States",
            "state": "California",
        },
    )
    assert registered.status_code == 201
    assert registered.json()["curriculum"]["foundation"] == "Pythagoras’ theorem"
    assert registered.json()["curriculum"]["jurisdiction"] == "California, United States"

    practice = learner.post("/learning-sessions")
    assert practice.status_code == 201
    practice_data = practice.json()

    foundation_step = learner.post(
        f"/learning-sessions/{practice_data['sessionId']}/steps",
        json={"rawLatex": "a^2 + b^2 = c^2", "confidence": 0.91, "timestamp": 1234567890},
    )
    assert foundation_step.json()["status"] == "correct"
    assert foundation_step.json()["stepAccepted"] is True

    problem = practice_problem(practice_data["problemId"])
    completed = learner.post(
        f"/learning-sessions/{practice_data['sessionId']}/steps",
        json={"rawLatex": f"c = {problem.hypotenuse}", "confidence": 0.91, "timestamp": 1234567891},
    )
    assert completed.json()["status"] == "correct"
    assert completed.json()["complete"] is True


def test_learning_session_explains_a_foundational_error():
    learner = TestClient(app)
    email = f"learner-{secrets.token_hex(6)}@example.test"
    learner.post(
        "/auth/register",
        json={
            "fullName": "Jordan Student",
            "email": email,
            "password": "safe-practice-password",
            "grade": 8,
            "country": "United States",
            "state": "Texas",
        },
    )
    practice = learner.post("/learning-sessions").json()
    response = learner.post(
        f"/learning-sessions/{practice['sessionId']}/steps",
        json={"rawLatex": "a + b^2 = c^2", "confidence": 0.91, "timestamp": 1234567890},
    )
    assert response.json()["status"] == "error"
    assert response.json()["errorType"] == "missing_square"
    assert response.json()["foundation"] == "Pythagoras’ theorem"

    review = learner.get(f"/learning-sessions/{practice['sessionId']}/review")
    assert review.status_code == 200
    assert review.json()["findings"][0]["rawLatex"] == "a + b^2 = c^2"
    assert review.json()["findings"][0]["errorType"] == "missing_square"


def test_student_can_request_a_specific_reason_for_a_flagged_line(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    learner = TestClient(app)
    learner.post(
        "/auth/register",
        json={
            "fullName": "Reason Student",
            "email": f"reason-{secrets.token_hex(6)}@example.test",
            "password": "safe-practice-password",
            "grade": 8,
            "country": "United States",
            "state": "Oregon",
        },
    )
    practice = learner.post("/learning-sessions").json()
    learner.post(
        f"/learning-sessions/{practice['sessionId']}/steps",
        json={"rawLatex": "a + b = c", "confidence": 0.91, "timestamp": 1234567890},
    )
    explanation = learner.post(
        f"/learning-sessions/{practice['sessionId']}/explain-step",
        json={"rawLatex": "a + b = c", "errorType": "missing_square"},
    )
    assert explanation.status_code == 200
    assert explanation.json()["provider"] == "Coach"
    assert "squaring" in explanation.json()["explanation"]


def test_learning_session_accepts_a_correct_numeric_solution_chain():
    """Equivalent numeric steps and reversed equalities remain correct."""
    learner = TestClient(app)
    email = f"numeric-chain-{secrets.token_hex(6)}@example.test"
    learner.post(
        "/auth/register",
        json={
            "fullName": "Numeric Student",
            "email": email,
            "password": "safe-practice-password",
            "grade": 7,
            "country": "United States",
            "state": "Oregon",
        },
    )
    practice_session_id = f"numeric-chain-{secrets.token_hex(6)}"
    with database_connection() as connection:
        connection.execute(
            "INSERT INTO edume_private.practice_sessions (id, student_id, problem_key, next_step, created_at) VALUES (%s, %s, %s, %s, %s)",
            (practice_session_id, learner.get("/me").json()["id"], "pythagoras_3_4_5", 0, 0),
        )

    steps = ["3^2 + 4^2 = c^2", "9 + 16 = c^2", r"\sqrt{25} = c", "5 = c"]
    results = [
        learner.post(
            f"/learning-sessions/{practice_session_id}/steps",
            json={"rawLatex": raw_latex, "confidence": 0.91, "timestamp": 1234567890},
        ).json()
        for raw_latex in steps
    ]
    assert [result["status"] for result in results] == ["correct", "correct", "correct", "correct"]
    assert results[-1]["complete"] is True


def test_algebraic_equations_topic_checks_each_balancing_step():
    learner = TestClient(app)
    email = f"algebra-topic-{secrets.token_hex(6)}@example.test"
    learner.post(
        "/auth/register",
        json={
            "fullName": "Algebra Student",
            "email": email,
            "password": "safe-practice-password",
            "grade": 8,
            "country": "United States",
            "state": "Oregon",
        },
    )
    session = learner.post("/learning-sessions", json={"topicKey": "algebraic_equations"}).json()
    assert session["topic"] == "Algebraic equations"
    assert session["foundation"] == "Solving algebraic equations"
    assert "2x + 3 = 11" in session["prompt"]

    results = [
        learner.post(
            f"/learning-sessions/{session['sessionId']}/steps",
            json={"rawLatex": raw_latex, "confidence": 0.91, "timestamp": 1234567890},
        ).json()
        for raw_latex in ["2x + 3 = 11", "2x = 8", "x = 4"]
    ]
    assert [result["status"] for result in results] == ["correct", "correct", "correct"]
    assert results[-1]["complete"] is True


def test_learning_session_explains_a_numeric_transcription_disagreement():
    learner = TestClient(app)
    email = f"numeric-hint-{secrets.token_hex(6)}@example.test"
    learner.post(
        "/auth/register",
        json={
            "fullName": "Feedback Student",
            "email": email,
            "password": "safe-practice-password",
            "grade": 7,
            "country": "United States",
            "state": "Oregon",
        },
    )
    with database_connection() as connection:
        session_id = f"numeric-hint-{secrets.token_hex(6)}"
        connection.execute(
            "INSERT INTO edume_private.practice_sessions (id, student_id, problem_key, next_step, created_at) VALUES (%s, %s, %s, %s, %s)",
            (session_id, learner.get("/me").json()["id"], "pythagoras_8_15_17", 0, 0),
        )
    result = learner.post(
        f"/learning-sessions/{session_id}/steps",
        json={"rawLatex": "64 + 255 = c^2", "confidence": 0.91, "timestamp": 1234567890},
    ).json()
    assert result["status"] == "error"
    assert result["errorType"] == "calculation_error"
    assert "64 + 225 = 289" in result["hint"]
    assert "transcription" in result["hint"]


def test_adaptive_tutor_uses_visual_preference_then_socratic_support():
    learner = TestClient(app)
    email = f"learner-{secrets.token_hex(6)}@example.test"
    registered = learner.post(
        "/auth/register",
        json={
            "fullName": "Visual Student",
            "email": email,
            "password": "safe-practice-password",
            "grade": 7,
            "country": "United States",
            "state": "Oregon",
            "tutorModes": ["visual", "guided"],
        },
    )
    assert registered.json()["tutorModes"] == ["visual", "guided"]

    practice = learner.post("/learning-sessions").json()
    assert practice["tutor"]["mode"] == "visual"
    assert practice["tutor"]["visualCue"]

    error = learner.post(
        f"/learning-sessions/{practice['sessionId']}/steps",
        json={"rawLatex": "a + b^2 = c^2", "confidence": 0.91, "timestamp": 1234567890},
    ).json()
    assert error["tutor"]["mode"] == "socratic"
    assert "visual" in error["tutor"]["supportingModes"]

    # The next correct attempt is attributed to the question-based prompt
    # that was active before the learner submitted it.
    correct = learner.post(
        f"/learning-sessions/{practice['sessionId']}/steps",
        json={"rawLatex": "a^2 + b^2 = c^2", "confidence": 0.91, "timestamp": 1234567891},
    ).json()
    assert correct["status"] == "correct"
    with database_connection() as connection:
        outcome = connection.execute(
            "SELECT outcome FROM edume_private.tutor_strategy_events WHERE student_id = %s AND mode = 'socratic' ORDER BY id DESC LIMIT 1",
            (registered.json()["id"],),
        ).fetchone()
    assert outcome["outcome"] == 1


def post_step(raw_latex: str, confidence: float = 0.91):
    return client.post(
        "/check-step",
        json={
            "sessionId": "abc123",
            "stepIndex": 2,
            "problemId": "pythagoras_01",
            "rawLatex": raw_latex,
            "confidence": confidence,
            "timestamp": 1234567890,
        },
    )


def test_correct_equation_is_accepted_when_reordered():
    response = post_step("b^2 + a^2 = c^2")
    assert response.status_code == 200
    assert response.json()["status"] == "correct"
    assert response.json()["errorType"] is None


def test_missing_square_is_classified():
    response = post_step("a + b^2 = c^2")
    assert response.json()["status"] == "error"
    assert response.json()["errorType"] == "missing_square"


def test_missing_all_squares_is_classified_as_a_formula_error():
    response = post_step("a + b = c")
    assert response.status_code == 200
    assert response.json()["status"] == "error"
    assert response.json()["errorType"] == "missing_square"


def test_wrong_hypotenuse_is_classified():
    response = post_step("a^2 + c^2 = b^2")
    assert response.json()["status"] == "error"
    assert response.json()["errorType"] == "wrong_hypotenuse"


def test_sign_error_is_classified():
    response = post_step("a^2 - b^2 = c^2")
    assert response.json()["status"] == "error"
    assert response.json()["errorType"] == "sign_error"


def test_low_ocr_confidence_skips_math_checking():
    response = post_step("this is not latex", confidence=0.59)
    body = response.json()
    assert body["status"] == "unclear"
    assert body["confidenceNote"] == "low OCR confidence, please rewrite"
