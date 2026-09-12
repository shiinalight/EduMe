"""HTTP service for checking recognized maths steps.

Run locally with: uvicorn main:app --reload
"""

from __future__ import annotations

import os
import secrets
import sqlite3
import time
from base64 import b64decode
from dataclasses import dataclass
from hashlib import pbkdf2_hmac
from pathlib import Path
from typing import Literal

import httpx
from fastapi import Cookie, FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sympy import Eq, Expr, Symbol, simplify
from sympy.parsing.latex import parse_latex

from heygen_video import create_video_router


a, b, c, x = Symbol("a"), Symbol("b"), Symbol("c"), Symbol("x")
DATABASE_PATH = Path(os.environ.get("MATH_TUTOR_DB", Path(__file__).parent / "student_data.db"))
TutorMode = Literal["guided", "socratic", "worked_example", "visual"]


@dataclass(frozen=True)
class WrongPattern:
    """A recognizable misconception and the relation(s) that express it."""

    error_type: str
    hint: str
    relations: tuple[Eq, ...]


@dataclass(frozen=True)
class ProblemDefinition:
    """All deterministic checking rules for one problem type."""

    problem_id: str
    correct_relation: Eq
    wrong_patterns: tuple[WrongPattern, ...]


# Add future exercises by adding another ProblemDefinition here; the endpoint and
# comparison engine do not need to change.
PROBLEMS: dict[str, ProblemDefinition] = {
    "pythagoras_01": ProblemDefinition(
        problem_id="pythagoras_01",
        correct_relation=Eq(a**2 + b**2, c**2),
        wrong_patterns=(
            WrongPattern(
                error_type="missing_square",
                hint="Check that every term is raised to the power 2.",
                relations=(
                    Eq(a + b**2, c**2),
                    Eq(a**2 + b, c**2),
                    Eq(a**2 + b**2, c),
                ),
            ),
            WrongPattern(
                error_type="wrong_hypotenuse",
                hint="Check which side is the hypotenuse before choosing the side on its own.",
                relations=(
                    Eq(a**2 + c**2, b**2),
                ),
            ),
            WrongPattern(
                error_type="sign_error",
                hint="Check whether the two squared leg terms should be added.",
                relations=(
                    Eq(a**2 - b**2, c**2),
                ),
            ),
        ),
    )
}


class CheckStepRequest(BaseModel):
    sessionId: str
    stepIndex: int = Field(ge=0)
    problemId: str
    rawLatex: str = Field(min_length=1)
    confidence: float = Field(ge=0, le=1)
    timestamp: int


class CheckStepResponse(BaseModel):
    stepIndex: int
    status: Literal["correct", "error", "unclear"]
    errorType: str | None
    hint: str
    confidenceNote: str | None


class RecognitionRequest(BaseModel):
    """An image produced by the tablet canvas, ready for an OCR provider."""

    imageData: str = Field(min_length=20, max_length=12_000_000)
    sessionId: str
    stepIndex: int = Field(ge=0)
    providerId: str = "local-pix2tex"


class RecognitionResponse(BaseModel):
    rawLatex: str
    confidence: float = Field(ge=0, le=1)
    provider: str


class InkMathLine(BaseModel):
    """One line transcribed by InkMath, kept separate from math evaluation."""

    text: str
    latex: str
    legibility: Literal["clear", "uncertain"]
    ambiguities: list[str] = Field(default_factory=list)


class InkMathDocumentResponse(BaseModel):
    """The safe subset of InkMath's multi-line transcription contract."""

    provider: str
    model: str | None = None
    lines: list[InkMathLine]
    warnings: list[str] = Field(default_factory=list)


class OcrProviderInfo(BaseModel):
    """A safe, browser-visible description of a server-configured OCR option."""

    id: str
    label: str
    description: str
    configured: bool


class OcrDefault(BaseModel):
    providerId: str


class RegisterRequest(BaseModel):
    fullName: str = Field(min_length=2, max_length=80)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128)
    grade: int = Field(ge=1, le=12)
    country: str = Field(min_length=2, max_length=80)
    state: str = Field(min_length=2, max_length=80)
    tutorModes: list[TutorMode] = Field(default_factory=lambda: ["guided"], min_length=1, max_length=4)


class LoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128)


class CurriculumContext(BaseModel):
    jurisdiction: str
    learningBand: str
    foundation: str
    explanation: str


class StudentProfile(BaseModel):
    id: int
    fullName: str
    email: str
    grade: int
    country: str
    state: str
    tutorModes: list[TutorMode]
    curriculum: CurriculumContext


class WorkedExample(BaseModel):
    title: str
    steps: list[str]
    handoff: str


class TutorGuidance(BaseModel):
    mode: TutorMode
    supportingModes: list[TutorMode] = Field(default_factory=list)
    prompt: str
    workedExample: WorkedExample | None = None
    visualCue: str | None = None


class PracticeSessionResponse(BaseModel):
    sessionId: str
    problemId: str
    topic: str
    prompt: str
    goal: str
    foundation: str
    nextStep: int
    tutor: TutorGuidance


class PracticeStepRequest(BaseModel):
    rawLatex: str = Field(min_length=1)
    confidence: float = Field(ge=0, le=1)
    timestamp: int


class LearningSessionRequest(BaseModel):
    """The concept selected on the Mathematics landing page."""

    topicKey: Literal["pythagoras", "algebraic_equations"] | None = None


class PracticeStepResponse(CheckStepResponse):
    stepAccepted: bool
    nextStep: int
    complete: bool
    foundation: str
    tutor: TutorGuidance = Field(default_factory=lambda: TutorGuidance(mode="guided", prompt="Try the next small step."))


class ReviewFinding(BaseModel):
    stepIndex: int
    rawLatex: str
    errorType: str | None
    explanation: str


class SolutionReview(BaseModel):
    foundation: str
    summary: str
    complete: bool
    findings: list[ReviewFinding]


def _residual(relation: Eq) -> Expr:
    return simplify(relation.lhs - relation.rhs)


def equations_are_equivalent(first: Eq, second: Eq) -> bool:
    """Return whether two equations have the same solution relation.

    Comparing residuals up to a non-zero constant recognizes reordered and
    rearranged forms, including a relation written with the other side first.
    """

    first_residual = _residual(first)
    second_residual = _residual(second)
    if simplify(first_residual - second_residual) == 0:
        return True
    if second_residual == 0:
        return first_residual == 0
    quotient = simplify(first_residual / second_residual)
    return bool(quotient.is_number and quotient != 0)


def parse_equation(raw_latex: str) -> Eq:
    parsed = parse_latex(raw_latex)
    if not isinstance(parsed, Eq):
        raise ValueError("The LaTeX input must contain one equality.")
    return parsed


def database_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    with database_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS students (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                grade INTEGER NOT NULL,
                country TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS login_sessions (
                token TEXT PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id),
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS practice_sessions (
                id TEXT PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id),
                problem_key TEXT NOT NULL,
                next_step INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS practice_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                practice_session_id TEXT NOT NULL REFERENCES practice_sessions(id),
                step_index INTEGER NOT NULL,
                raw_latex TEXT NOT NULL,
                status TEXT NOT NULL,
                error_type TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS student_tutor_preferences (
                student_id INTEGER NOT NULL REFERENCES students(id),
                mode TEXT NOT NULL,
                PRIMARY KEY (student_id, mode)
            );
            CREATE TABLE IF NOT EXISTS tutor_strategy_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL REFERENCES students(id),
                foundation TEXT NOT NULL,
                mode TEXT NOT NULL,
                outcome INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS session_tutor_state (
                practice_session_id TEXT PRIMARY KEY REFERENCES practice_sessions(id),
                active_mode TEXT NOT NULL
            );
            """
        )


def password_record(password: str) -> tuple[str, str]:
    salt = secrets.token_bytes(16)
    digest = pbkdf2_hmac("sha256", password.encode(), salt, 210_000)
    return salt.hex(), digest.hex()


def password_matches(password: str, salt_hex: str, expected_hash: str) -> bool:
    actual = pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 210_000).hex()
    return secrets.compare_digest(actual, expected_hash)


def curriculum_context_for(grade: int, country: str, state: str) -> CurriculumContext:
    """Centralised starter rules; replace/add jurisdiction rules as content grows."""

    jurisdiction = f"{state}, {country}"
    if grade <= 5:
        band = "Upper elementary"
        foundation = "Squares and area"
        explanation = "Build confidence with square numbers and the area of square shapes before formal triangle relationships."
    elif grade <= 8:
        band = "Middle school"
        foundation = "Pythagoras’ theorem"
        explanation = "Connect square numbers to the side lengths of a right triangle."
    else:
        band = "Secondary geometry"
        foundation = "Pythagoras’ theorem and algebraic rearrangement"
        explanation = "Use the theorem fluently and rearrange it to find an unknown side."
    return CurriculumContext(jurisdiction=jurisdiction, learningBand=band, foundation=foundation, explanation=explanation)


def student_profile(row: sqlite3.Row) -> StudentProfile:
    tutor_modes = preferred_tutor_modes(row["id"])
    return StudentProfile(
        id=row["id"],
        fullName=row["full_name"],
        email=row["email"],
        grade=row["grade"],
        country=row["country"],
        state=row["state"],
        tutorModes=tutor_modes,
        curriculum=curriculum_context_for(row["grade"], row["country"], row["state"]),
    )


def preferred_tutor_modes(student_id: int) -> list[TutorMode]:
    with database_connection() as connection:
        rows = connection.execute(
            "SELECT mode FROM student_tutor_preferences WHERE student_id = ? ORDER BY rowid",
            (student_id,),
        ).fetchall()
    modes = [row["mode"] for row in rows if row["mode"] in {"guided", "socratic", "worked_example", "visual"}]
    return modes or ["guided"]


def authenticated_student(session_token: str | None) -> sqlite3.Row:
    if not session_token:
        raise HTTPException(status_code=401, detail="Please sign in to begin a practice session.")
    with database_connection() as connection:
        student = connection.execute(
            """
            SELECT students.* FROM students
            JOIN login_sessions ON login_sessions.student_id = students.id
            WHERE login_sessions.token = ?
            """,
            (session_token,),
        ).fetchone()
    if student is None:
        raise HTTPException(status_code=401, detail="Your sign-in session has expired.")
    return student


@dataclass(frozen=True)
class PracticeProblem:
    key: str
    topic_key: Literal["pythagoras", "algebraic_equations"]
    topic: str
    foundation: str
    leg_a: int | None = None
    leg_b: int | None = None
    hypotenuse: int | None = None

    @property
    def prompt(self) -> str:
        if self.topic_key == "algebraic_equations":
            return "Solve 2x + 3 = 11. Show one equation per line."
        assert self.leg_a is not None and self.leg_b is not None
        return f"A right triangle has legs a = {self.leg_a} and b = {self.leg_b}. Find the hypotenuse c. Show one equation per line."

    @property
    def expected_relations(self) -> tuple[Eq, ...]:
        if self.topic_key == "algebraic_equations":
            return (Eq(2*x + 3, 11), Eq(2*x, 8), Eq(x, 4))
        assert self.leg_a is not None and self.leg_b is not None and self.hypotenuse is not None
        return (
            Eq(a**2 + b**2, c**2),
            Eq(self.leg_a**2 + self.leg_b**2, c**2),
            Eq(c, self.hypotenuse),
        )


PRACTICE_PROBLEMS: tuple[PracticeProblem, ...] = (
    PracticeProblem("pythagoras_3_4_5", "pythagoras", "Pythagoras’ theorem", "Pythagoras’ theorem", 3, 4, 5),
    PracticeProblem("pythagoras_5_12_13", "pythagoras", "Pythagoras’ theorem", "Pythagoras’ theorem", 5, 12, 13),
    PracticeProblem("pythagoras_8_15_17", "pythagoras", "Pythagoras’ theorem", "Pythagoras’ theorem", 8, 15, 17),
    PracticeProblem("algebraic_equation_2x_plus_3", "algebraic_equations", "Algebraic equations", "Solving algebraic equations"),
)


def practice_problem(key: str) -> PracticeProblem:
    for problem in PRACTICE_PROBLEMS:
        if problem.key == key:
            return problem
    raise HTTPException(status_code=500, detail="The saved practice problem is unavailable.")


def foundation_error(student_relation: Eq) -> WrongPattern | None:
    for pattern in PROBLEMS["pythagoras_01"].wrong_patterns:
        if any(equations_are_equivalent(student_relation, relation) for relation in pattern.relations):
            return pattern
    return None


def numeric_pythagoras_hint(problem: PracticeProblem, student_relation: Eq) -> str | None:
    """Explain a misread numeric substitution instead of issuing a vague cue."""

    if problem.topic_key != "pythagoras":
        return None
    assert problem.leg_a is not None and problem.leg_b is not None
    expected_total = problem.leg_a**2 + problem.leg_b**2
    for numeric_side, other_side in (
        (student_relation.lhs, student_relation.rhs),
        (student_relation.rhs, student_relation.lhs),
    ):
        if simplify(other_side - c**2) == 0:
            simplified_value = simplify(numeric_side)
            if simplified_value.is_number and simplified_value != expected_total:
                return (
                    f"For this triangle, {problem.leg_a}² + {problem.leg_b}² = "
                    f"{problem.leg_a**2} + {problem.leg_b**2} = {expected_total}. "
                    "Check the transcription above: InkMath may have read one digit differently from your writing."
                )
    return None


def algebra_step_index(raw_latex: str, relation: Eq) -> int | None:
    """Keep the authored order for simple equation-solving moves.

    All three equations have the same mathematical solution, so pure symbolic
    equivalence cannot tell whether the learner has subtracted first or
    divided first.  This small recogniser preserves the visible teaching
    sequence while still allowing either side of an equality to be reversed.
    """

    compact = raw_latex.replace(" ", "").replace("{", "").replace("}", "").lower()
    if "2x" in compact and "3" in compact and "11" in compact:
        return 0
    if "2x" in compact and "8" in compact and "3" not in compact:
        return 1
    if "2x" not in compact and "x" in compact and "4" in compact:
        return 2
    return None


def explanation_for_error(error_type: str | None) -> str:
    for pattern in PROBLEMS["pythagoras_01"].wrong_patterns:
        if pattern.error_type == error_type:
            return pattern.hint
    if error_type == "unparseable_latex":
        return "Write this as one complete equation so the next mathematical move is clear."
    if error_type is None:
        return "Rewrite this line clearly, then check it again."
    return "Check that this line follows from the previous equation before simplifying further."


def guided_prompt(next_step: int, problem: PracticeProblem) -> str:
    if problem.topic_key == "algebraic_equations":
        if next_step <= 1:
            return "What can you do to both sides to remove the + 3?"
        return "Now 2x equals 8. What inverse operation leaves x on its own?"
    assert problem.leg_a is not None and problem.leg_b is not None
    if next_step == 0:
        return "Start by writing the relationship between the two shorter sides and the hypotenuse."
    if next_step == 1:
        return f"Now substitute a = {problem.leg_a} and b = {problem.leg_b}, then simplify the squares."
    return "You have the squared hypotenuse. What positive value of c makes that true?"


def socratic_prompt(error_type: str | None, next_step: int) -> str:
    probes = {
        "missing_square": "Look at all three side lengths: what operation should happen to each length before they are compared?",
        "wrong_hypotenuse": "Which side sits opposite the right angle? Should that side be alone or added to another side?",
        "sign_error": "When comparing square areas, are the two shorter-side squares combined by adding or subtracting?",
    }
    return probes.get(error_type, "What does the previous line tell you must stay equal as you make this next move?") if next_step else "Which side is opposite the right angle, and what do you know about its square?"


def worked_example_for(problem: PracticeProblem) -> WorkedExample:
    if problem.topic_key == "algebraic_equations":
        return WorkedExample(
            title="Parallel example: solve 3x + 2 = 14",
            steps=["3x + 2 = 14", "3x = 12", "x = 4"],
            handoff="Use the same idea: undo the addition first, then undo the multiplication.",
        )
    assert problem.leg_a is not None and problem.leg_b is not None
    return WorkedExample(
        title="Parallel example: a 6–8–10 right triangle",
        steps=["6² + 8² = c²", "36 + 64 = c²", "100 = c²", "c = 10"],
        handoff=f"Use the same four moves for a = {problem.leg_a} and b = {problem.leg_b}.",
    )


def visual_cue_for(next_step: int) -> str:
    if next_step == 0:
        return "Look at the side opposite the 90° corner. That is c, so its square belongs on its own."
    if next_step == 1:
        return "The two shorter sides meet at the right angle. Their squared areas combine to match the square on c."
    return "Keep c as a positive side length when you take the square root."


def adaptive_tutor_guidance(
    student_id: int,
    learning_session_id: str,
    problem: PracticeProblem,
    next_step: int,
    error_type: str | None = None,
) -> TutorGuidance:
    """Select authored teaching support from preferences and recent evidence."""

    preferred = preferred_tutor_modes(student_id)
    applicable_preferred = [mode for mode in preferred if mode != "visual" or problem.topic_key == "pythagoras"] or ["guided"]
    with database_connection() as connection:
        repeated_errors = connection.execute(
            """
            SELECT COUNT(*) AS count FROM practice_steps
            JOIN practice_sessions ON practice_sessions.id = practice_steps.practice_session_id
            WHERE practice_sessions.student_id = ? AND practice_steps.error_type = ?
            """,
            (student_id, error_type),
        ).fetchone()["count"] if error_type else 0
        performance = connection.execute(
            """
            SELECT mode, AVG(outcome) AS success_rate, COUNT(*) AS attempts
            FROM tutor_strategy_events
            WHERE student_id = ? AND foundation = ?
            GROUP BY mode
            """,
            (student_id, "Pythagoras’ theorem"),
        ).fetchall()

    performance_by_mode = {row["mode"]: row for row in performance}
    if error_type and repeated_errors >= 2:
        mode: TutorMode = "worked_example"
    elif error_type:
        mode = "socratic"
    elif "visual" in preferred and next_step == 0 and problem.topic_key == "pythagoras":
        mode = "visual"
    else:
        successful_preferred = [
            candidate for candidate in applicable_preferred
            if candidate in performance_by_mode and performance_by_mode[candidate]["attempts"] >= 2
            and performance_by_mode[candidate]["success_rate"] >= 0.6
        ]
        mode = successful_preferred[0] if successful_preferred else applicable_preferred[0]

    supporting: list[TutorMode] = []
    visual_cue = None
    if "visual" in preferred and mode != "visual" and problem.topic_key == "pythagoras":
        supporting.append("visual")
        visual_cue = visual_cue_for(next_step)
    if mode == "guided":
        prompt = guided_prompt(next_step, problem)
        worked_example = None
    elif mode == "socratic":
        prompt = (
            "What operation would undo the last change to x while keeping both sides balanced?"
            if problem.topic_key == "algebraic_equations"
            else socratic_prompt(error_type, next_step)
        )
        worked_example = None
    elif mode == "worked_example":
        prompt = "Compare this parallel example with your problem, then try the same structure."
        worked_example = worked_example_for(problem)
    else:
        prompt = visual_cue_for(next_step)
        visual_cue = prompt
        worked_example = None
    return TutorGuidance(
        mode=mode,
        supportingModes=supporting,
        prompt=prompt,
        workedExample=worked_example,
        visualCue=visual_cue,
    )


def active_tutor_mode(learning_session_id: str) -> TutorMode:
    with database_connection() as connection:
        row = connection.execute(
            "SELECT active_mode FROM session_tutor_state WHERE practice_session_id = ?",
            (learning_session_id,),
        ).fetchone()
    return row["active_mode"] if row and row["active_mode"] in {"guided", "socratic", "worked_example", "visual"} else "guided"


def set_active_tutor_mode(learning_session_id: str, mode: TutorMode) -> None:
    with database_connection() as connection:
        connection.execute(
            """
            INSERT INTO session_tutor_state (practice_session_id, active_mode) VALUES (?, ?)
            ON CONFLICT(practice_session_id) DO UPDATE SET active_mode = excluded.active_mode
            """,
            (learning_session_id, mode),
        )


def record_strategy_outcome(student_id: int, mode: TutorMode, accepted: bool) -> None:
    with database_connection() as connection:
        connection.execute(
            "INSERT INTO tutor_strategy_events (student_id, foundation, mode, outcome, created_at) VALUES (?, ?, ?, ?, ?)",
            (student_id, "Pythagoras’ theorem", mode, int(accepted), int(time.time())),
        )


initialize_database()
app = FastAPI(title="Math Step Detection Service")
app.include_router(create_video_router(authenticated_student, database_connection))
STATIC_DIR = Path(__file__).parent / "static"


def team_ocr_url() -> str | None:
    """Retain OCR_SERVICE_URL compatibility while preferring the clearer name."""

    return os.environ.get("TEAM_OCR_URL") or os.environ.get("OCR_SERVICE_URL")


def inkmath_ocr_url() -> str:
    """Local teammate project; override if it is hosted at a different address."""

    return os.environ.get("INKMATH_OCR_URL", "http://127.0.0.1:3000/api/recognize")


def ocr_providers() -> list[OcrProviderInfo]:
    return [
        OcrProviderInfo(
            id="local-pix2tex",
            label="Local Pix2Tex",
            description="Runs on this computer using Docker; no API key needed.",
            configured=True,
        ),
        OcrProviderInfo(
            id="team-ocr",
            label=os.environ.get("TEAM_OCR_NAME", "Team OCR"),
            description="Your teammate's recognizer, connected through a server-side adapter.",
            configured=bool(team_ocr_url()),
        ),
        OcrProviderInfo(
            id="inkmath",
            label="InkMath",
            description="Local structured handwriting OCR from the teammate project.",
            configured=True,
        ),
    ]


def default_ocr_provider() -> str:
    requested = os.environ.get("DEFAULT_OCR_PROVIDER", "inkmath")
    known = {provider.id for provider in ocr_providers()}
    return requested if requested in known else "inkmath"


@app.get("/")
def health_check() -> dict[str, str]:
    """A friendly response for browsers and deployment health checks."""

    return {
        "status": "ok",
        "message": "Math Step Detection Service is running. Send POST requests to /check-step.",
        "docs": "/docs",
        "tabletApp": "/app",
    }


def set_login_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="math_tutor_session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 14,
    )


@app.post("/auth/register", response_model=StudentProfile, status_code=201)
def register_student(request: RegisterRequest, response: Response) -> StudentProfile:
    email = request.email.strip().lower()
    salt, digest = password_record(request.password)
    try:
        with database_connection() as connection:
            cursor = connection.execute(
                """
                INSERT INTO students (full_name, email, password_salt, password_hash, grade, country, state, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (request.fullName.strip(), email, salt, digest, request.grade, request.country.strip(), request.state.strip(), int(time.time())),
            )
            student_id = cursor.lastrowid
            token = secrets.token_urlsafe(32)
            connection.execute(
                "INSERT INTO login_sessions (token, student_id, created_at) VALUES (?, ?, ?)",
                (token, student_id, int(time.time())),
            )
            connection.executemany(
                "INSERT INTO student_tutor_preferences (student_id, mode) VALUES (?, ?)",
                [(student_id, mode) for mode in dict.fromkeys(request.tutorModes)],
            )
            student = connection.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="An account with this email already exists.") from exc
    set_login_cookie(response, token)
    return student_profile(student)


@app.post("/auth/login", response_model=StudentProfile)
def login_student(request: LoginRequest, response: Response) -> StudentProfile:
    with database_connection() as connection:
        student = connection.execute("SELECT * FROM students WHERE email = ?", (request.email.strip().lower(),)).fetchone()
        if student is None or not password_matches(request.password, student["password_salt"], student["password_hash"]):
            raise HTTPException(status_code=401, detail="Email or password was not recognized.")
        token = secrets.token_urlsafe(32)
        connection.execute(
            "INSERT INTO login_sessions (token, student_id, created_at) VALUES (?, ?, ?)",
            (token, student["id"], int(time.time())),
        )
    set_login_cookie(response, token)
    return student_profile(student)


@app.post("/auth/logout", status_code=204)
def logout_student(response: Response, math_tutor_session: str | None = Cookie(default=None)) -> Response:
    if math_tutor_session:
        with database_connection() as connection:
            connection.execute("DELETE FROM login_sessions WHERE token = ?", (math_tutor_session,))
    response.delete_cookie("math_tutor_session")
    return response


@app.get("/me", response_model=StudentProfile)
def get_current_student(math_tutor_session: str | None = Cookie(default=None)) -> StudentProfile:
    return student_profile(authenticated_student(math_tutor_session))


@app.post("/learning-sessions", response_model=PracticeSessionResponse, status_code=201)
def create_learning_session(
    request: LearningSessionRequest = LearningSessionRequest(),
    math_tutor_session: str | None = Cookie(default=None),
) -> PracticeSessionResponse:
    student = authenticated_student(math_tutor_session)
    if request.topicKey == "algebraic_equations":
        problem = practice_problem("algebraic_equation_2x_plus_3")
    else:
        problem = secrets.choice([item for item in PRACTICE_PROBLEMS if item.topic_key == "pythagoras"])
    session_id = secrets.token_urlsafe(18)
    with database_connection() as connection:
        connection.execute(
            "INSERT INTO practice_sessions (id, student_id, problem_key, next_step, created_at) VALUES (?, ?, ?, ?, ?)",
            (session_id, student["id"], problem.key, 0, int(time.time())),
        )
    curriculum = curriculum_context_for(student["grade"], student["country"], student["state"])
    tutor = adaptive_tutor_guidance(student["id"], session_id, problem, next_step=0)
    set_active_tutor_mode(session_id, tutor.mode)
    return PracticeSessionResponse(
        sessionId=session_id,
        problemId=problem.key,
        topic=problem.topic,
        prompt=problem.prompt,
        goal=("Find x = 4 by keeping both sides of the equation balanced." if problem.topic_key == "algebraic_equations" else f"Find c = {problem.hypotenuse} by connecting the triangle sides with an equation."),
        foundation=problem.foundation,
        nextStep=0,
        tutor=tutor,
    )


@app.post("/learning-sessions/{learning_session_id}/steps", response_model=PracticeStepResponse)
def check_learning_step(
    learning_session_id: str,
    request: PracticeStepRequest,
    math_tutor_session: str | None = Cookie(default=None),
) -> PracticeStepResponse:
    student = authenticated_student(math_tutor_session)
    with database_connection() as connection:
        session = connection.execute(
            "SELECT * FROM practice_sessions WHERE id = ? AND student_id = ?",
            (learning_session_id, student["id"]),
        ).fetchone()
    if session is None:
        raise HTTPException(status_code=404, detail="Practice session not found.")

    problem = practice_problem(session["problem_key"])
    curriculum = curriculum_context_for(student["grade"], student["country"], student["state"])
    next_step = session["next_step"]
    expected = problem.expected_relations

    if request.confidence < 0.6:
        result = PracticeStepResponse(
            stepIndex=next_step,
            status="unclear",
            errorType=None,
            hint="Please rewrite this step so I can read it clearly.",
            confidenceNote="low OCR confidence, please rewrite",
            stepAccepted=False,
            nextStep=next_step,
            complete=False,
            foundation=problem.foundation,
        )
    else:
        try:
            student_relation = parse_equation(request.rawLatex)
        except Exception:
            result = PracticeStepResponse(
                stepIndex=next_step,
                status="unclear",
                errorType="unparseable_latex",
                hint="Please rewrite this as one equation so I can follow the step.",
                confidenceNote="could not parse recognized math",
                stepAccepted=False,
                nextStep=next_step,
                complete=False,
                foundation=problem.foundation,
            )
        else:
            # A learner may start directly with substituted values, repeat an
            # equivalent simplification, or write the equality the other way
            # round.  Each is still a valid mathematical statement.  Compare
            # against the complete, authored solution path rather than only
            # the next database index; progress never moves backwards.
            matching_step = (
                algebra_step_index(request.rawLatex, student_relation)
                if problem.topic_key == "algebraic_equations"
                else next(
                    (index for index, relation in enumerate(expected) if equations_are_equivalent(student_relation, relation)),
                    None,
                )
            )
            if matching_step is not None:
                advanced_to = max(next_step, matching_step + 1)
                complete = advanced_to == len(expected)
                shortcut = matching_step > next_step
                hint = (
                    ("You found x = 4. You have completed this problem." if problem.topic_key == "algebraic_equations" else f"You found c = {problem.hypotenuse}. You have completed this problem.")
                    if complete
                    else ("Good—now divide both sides by 2 to leave x on its own." if problem.topic_key == "algebraic_equations" else "That equation connects the right triangle’s side lengths. Now simplify the squares.")
                    if next_step == 0
                    else ("Good algebraic move. Keep both sides balanced as you solve for x." if problem.topic_key == "algebraic_equations" else "Good simplification. Now solve for c.")
                )
                if shortcut and not complete:
                    hint = "That is a valid shortcut. You can now solve for c."
                result = PracticeStepResponse(
                    stepIndex=next_step,
                    status="correct",
                    errorType=None,
                    hint=hint,
                    confidenceNote=None,
                    stepAccepted=True,
                    nextStep=advanced_to,
                    complete=complete,
                    foundation=problem.foundation,
                )
            else:
                known_error = foundation_error(student_relation)
                if known_error:
                    error_type, hint = known_error.error_type, known_error.hint
                else:
                    error_type = "does_not_follow"
                    hint = numeric_pythagoras_hint(problem, student_relation) or (
                        "Check that this equation follows from the previous line, then simplify one part at a time."
                    )
                result = PracticeStepResponse(
                    stepIndex=next_step,
                    status="error",
                    errorType=error_type,
                    hint=hint,
                    confidenceNote=None,
                    stepAccepted=False,
                    nextStep=next_step,
                    complete=False,
                    foundation=problem.foundation,
                )

    # Evaluate the strategy offered before this attempt, then choose the next
    # response from the learner's preferences and current performance.
    record_strategy_outcome(student["id"], active_tutor_mode(learning_session_id), result.stepAccepted)
    tutor = adaptive_tutor_guidance(
        student["id"],
        learning_session_id,
        problem,
        result.nextStep,
        result.errorType if result.status == "error" else None,
    )
    set_active_tutor_mode(learning_session_id, tutor.mode)
    result = result.model_copy(update={"tutor": tutor})

    with database_connection() as connection:
        connection.execute(
            "INSERT INTO practice_steps (practice_session_id, step_index, raw_latex, status, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (learning_session_id, next_step, request.rawLatex, result.status, result.errorType, int(time.time())),
        )
        if result.stepAccepted:
            connection.execute("UPDATE practice_sessions SET next_step = ? WHERE id = ?", (result.nextStep, learning_session_id))
    return result


@app.get("/learning-sessions/{learning_session_id}/review", response_model=SolutionReview)
def review_learning_session(
    learning_session_id: str,
    math_tutor_session: str | None = Cookie(default=None),
) -> SolutionReview:
    """Summarise the learner's submitted work and relate errors to a foundation."""

    student = authenticated_student(math_tutor_session)
    with database_connection() as connection:
        session = connection.execute(
            "SELECT * FROM practice_sessions WHERE id = ? AND student_id = ?",
            (learning_session_id, student["id"]),
        ).fetchone()
        if session is None:
            raise HTTPException(status_code=404, detail="Practice session not found.")
        incorrect_steps = connection.execute(
            """
            SELECT step_index, raw_latex, error_type FROM practice_steps
            WHERE practice_session_id = ? AND status != 'correct'
            ORDER BY id
            """,
            (learning_session_id,),
        ).fetchall()

    problem = practice_problem(session["problem_key"])
    complete = session["next_step"] >= len(problem.expected_relations)
    findings = [
        ReviewFinding(
            stepIndex=row["step_index"],
            rawLatex=row["raw_latex"],
            errorType=row["error_type"],
            explanation=explanation_for_error(row["error_type"]),
        )
        for row in incorrect_steps
    ]
    if complete:
        summary = "You completed the solution. Review the highlighted attempts to see which idea you corrected along the way."
    elif findings:
        summary = "These lines need another look. Start with the foundation, then revise the earliest flagged step."
    else:
        summary = "Your submitted steps are on track so far. Continue by simplifying the squares and solving for c."
    curriculum = curriculum_context_for(student["grade"], student["country"], student["state"])
    return SolutionReview(foundation=problem.foundation, summary=summary, complete=complete, findings=findings)


@app.get("/ocr-providers", response_model=list[OcrProviderInfo])
def list_ocr_providers() -> list[OcrProviderInfo]:
    """List selectable OCR providers without exposing URLs or credentials."""

    return ocr_providers()


@app.get("/ocr-default", response_model=OcrDefault)
def get_default_ocr_provider() -> OcrDefault:
    """The server decides which configured OCR runs behind full-solution review."""

    return OcrDefault(providerId=default_ocr_provider())


async def recognize_with_team_ocr(request: RecognitionRequest, url: str) -> RecognitionResponse:
    """Adapter seam for a teammate's OCR service.

    Adapt this one function if their request/response fields differ. The
    frontend and math checker retain the same stable contract.
    """

    payload = {
        "imageData": request.imageData,
        "sessionId": request.sessionId,
        "stepIndex": request.stepIndex,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(url, json=payload)
        response.raise_for_status()
        result = response.json()
    return RecognitionResponse(
        rawLatex=result["rawLatex"],
        confidence=result["confidence"],
        provider=result.get("provider", os.environ.get("TEAM_OCR_NAME", "Team OCR")),
    )


async def recognize_inkmath_document(request: RecognitionRequest) -> InkMathDocumentResponse:
    """Proxy InkMath's complete, ordered transcription without exposing its key."""

    async with httpx.AsyncClient(timeout=50) as client:
        response = await client.post(inkmath_ocr_url(), json={"image": request.imageData})
        response.raise_for_status()
        result = response.json()
    lines = result.get("lines", [])
    if not isinstance(lines, list) or not lines:
        raise ValueError("InkMath returned no readable mathematical line.")
    return InkMathDocumentResponse(
        provider="InkMath",
        model=result.get("model"),
        lines=lines,
        warnings=result.get("warnings", []),
    )


async def recognize_with_inkmath(request: RecognitionRequest) -> RecognitionResponse:
    """Adapt InkMath's first line for the older single-step OCR contract."""

    document = await recognize_inkmath_document(request)
    first_line = document.lines[0]
    raw_latex = first_line.latex
    if not raw_latex.strip():
        raise ValueError("InkMath could not produce LaTeX for this line.")
    confidence = 0.91 if first_line.legibility == "clear" else 0.55
    provider = f"InkMath ({document.model or 'structured handwriting OCR'})"
    return RecognitionResponse(rawLatex=raw_latex, confidence=confidence, provider=provider)


@app.post("/recognize-handwriting/inkmath", response_model=InkMathDocumentResponse)
async def recognize_full_inkmath_document(request: RecognitionRequest) -> InkMathDocumentResponse:
    """Use one canvas snapshot so InkMath retains line order and uncertainty notes."""

    if request.providerId != "inkmath":
        raise HTTPException(status_code=422, detail="This endpoint is only for the InkMath provider.")
    try:
        return await recognize_inkmath_document(request)
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=503,
            detail="InkMath OCR is unavailable. Start the InkMath server at port 3000 with GEMINI_API_KEY configured.",
        ) from exc


@app.post("/recognize-handwriting", response_model=RecognitionResponse)
async def recognize_handwriting(request: RecognitionRequest) -> RecognitionResponse:
    """Recognize a drawing with one of the server-configured OCR providers."""

    if request.providerId not in {provider.id for provider in ocr_providers()}:
        raise HTTPException(status_code=422, detail="Unknown OCR provider.")

    if request.providerId == "team-ocr":
        url = team_ocr_url()
        if not url:
            raise HTTPException(
                status_code=503,
                detail="Team OCR is not configured. Set TEAM_OCR_URL before selecting it.",
            )
        try:
            return await recognize_with_team_ocr(request, url)
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=502,
                detail="Team OCR did not return the expected LaTeX result.",
            ) from exc

    if request.providerId == "inkmath":
        try:
            return await recognize_with_inkmath(request)
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=503,
                detail="InkMath OCR is unavailable. Start the InkMath server at port 3000 with GEMINI_API_KEY configured.",
            ) from exc

    try:
        if not request.imageData.startswith("data:image/png;base64,"):
            raise ValueError("Expected a PNG data URL.")
        image_bytes = b64decode(request.imageData.split(",", 1)[1], validate=True)
        async with httpx.AsyncClient(timeout=20) as client:
            # The local, self-hosted default. compose.yaml starts this at port 8502.
            pix2tex_url = os.environ.get("PIX2TEX_URL", "http://127.0.0.1:8502/predict/")
            response = await client.post(
                pix2tex_url,
                files={"file": ("handwriting.png", image_bytes, "image/png")},
            )
            response.raise_for_status()
            raw_latex = response.json()
            if not isinstance(raw_latex, str) or not raw_latex.strip():
                raise ValueError("Pix2Tex returned no LaTeX.")
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=503,
            detail="Local handwriting OCR is not running. Start it with: docker compose up ocr",
        ) from exc

    # Pix2Tex does not expose calibrated confidence; require students to review it.
    return RecognitionResponse(rawLatex=raw_latex, confidence=0.75, provider="local Pix2Tex")


@app.post("/check-step", response_model=CheckStepResponse)
def check_step(request: CheckStepRequest) -> CheckStepResponse:
    if request.confidence < 0.6:
        return CheckStepResponse(
            stepIndex=request.stepIndex,
            status="unclear",
            errorType=None,
            hint="Please rewrite this step so I can read it clearly.",
            confidenceNote="low OCR confidence, please rewrite",
        )

    problem = PROBLEMS.get(request.problemId)
    if problem is None:
        return CheckStepResponse(
            stepIndex=request.stepIndex,
            status="unclear",
            errorType="unknown_problem",
            hint="This problem type is not ready to check yet.",
            confidenceNote=None,
        )

    try:
        student_relation = parse_equation(request.rawLatex)
    except Exception:  # Parser errors are user-facing uncertainty, not server errors.
        return CheckStepResponse(
            stepIndex=request.stepIndex,
            status="unclear",
            errorType="unparseable_latex",
            hint="Please rewrite this step so I can check the equation.",
            confidenceNote="could not parse recognized math",
        )

    if equations_are_equivalent(student_relation, problem.correct_relation):
        return CheckStepResponse(
            stepIndex=request.stepIndex,
            status="correct",
            errorType=None,
            hint="This step matches Pythagoras' theorem.",
            confidenceNote=None,
        )

    for pattern in problem.wrong_patterns:
        if any(equations_are_equivalent(student_relation, relation) for relation in pattern.relations):
            return CheckStepResponse(
                stepIndex=request.stepIndex,
                status="error",
                errorType=pattern.error_type,
                hint=pattern.hint,
                confidenceNote=None,
            )

    return CheckStepResponse(
        stepIndex=request.stepIndex,
        status="error",
        errorType="unrecognized_relation",
        hint="Check the squared terms and which side is the hypotenuse.",
        confidenceNote=None,
    )


app.mount("/app", StaticFiles(directory=STATIC_DIR, html=True), name="tablet-app")
