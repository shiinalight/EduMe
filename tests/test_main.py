import secrets

from fastapi.testclient import TestClient

from main import app, practice_problem


client = TestClient(app)


def test_root_confirms_service_is_running():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_tablet_frontend_is_served():
    response = client.get("/app/")
    assert response.status_code == 200
    assert "Write with Apple Pencil" in response.text


def test_ocr_provider_list_keeps_local_and_team_options(monkeypatch):
    monkeypatch.delenv("TEAM_OCR_URL", raising=False)
    monkeypatch.delenv("OCR_SERVICE_URL", raising=False)
    providers = client.get("/ocr-providers").json()
    assert [provider["id"] for provider in providers] == ["local-pix2tex", "team-ocr"]
    assert providers[1]["configured"] is False


def test_default_ocr_provider_is_local_unless_configured(monkeypatch):
    monkeypatch.delenv("DEFAULT_OCR_PROVIDER", raising=False)
    assert client.get("/ocr-default").json()["providerId"] == "local-pix2tex"
    monkeypatch.setenv("DEFAULT_OCR_PROVIDER", "team-ocr")
    assert client.get("/ocr-default").json()["providerId"] == "team-ocr"


def test_recognizer_explains_when_no_provider_is_configured(monkeypatch):
    monkeypatch.delenv("OCR_SERVICE_URL", raising=False)
    monkeypatch.setenv("PIX2TEX_URL", "http://127.0.0.1:9/predict/")
    response = client.post(
        "/recognize-handwriting",
        json={"imageData": "data:image/png;base64," + "A" * 30, "sessionId": "abc123", "stepIndex": 0},
    )
    assert response.status_code == 503


def test_team_recognizer_requires_its_own_configuration(monkeypatch):
    monkeypatch.delenv("TEAM_OCR_URL", raising=False)
    monkeypatch.delenv("OCR_SERVICE_URL", raising=False)
    response = client.post(
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
