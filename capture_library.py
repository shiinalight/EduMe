"""Private, reviewed question storage and non-grading imported practice.

Uses the host's cookie authentication and SQLite connection. No provider calls,
media storage, solution generation, or imports from the host application.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import sqlite3
import time
from collections.abc import Callable
from typing import Annotated, Any, Literal
from urllib.parse import parse_qsl, urlsplit
from uuid import uuid4

from fastapi import APIRouter, Cookie, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

# Reuse the capture boundary's strict JSON and browser-origin checks.
from math_capture import _same_origin, _strict_json

MAX_NOTEBOOK_BYTES = 256 * 1024
MAX_STEP_LENGTH = 16_000
MAX_SAVED_STEPS = 500
IMPORTED_FOUNDATION = "Imported question — self-guided practice"
UNGRADED_NOTICE = "Your work is saved, not automatically graded. No correctness or completion assessment is available for this imported question."
IMPORTED_GUIDANCE = "Read the question, identify the given information and the unknown, then write one small step. Review your reasoning with a teacher or a trusted solution."


def reviewed_text(value: str) -> str:
    value.encode("utf-8", errors="strict")
    if re.search(r"data:(?:image|audio)/|-----BEGIN .*PRIVATE KEY-----|\b(?:Bearer\s+\S+|AIza[\w-]{30,}|sk-[\w-]{20,})", value, re.I):
        raise ValueError("Store reviewed question text only, not media or credentials.")
    return value


Text = Annotated[str, StringConstraints(max_length=MAX_STEP_LENGTH), AfterValidator(reviewed_text)]
ShortText = Annotated[str, StringConstraints(max_length=1000), AfterValidator(reviewed_text)]


def public_source_url(value: str) -> str:
    """Validate a public-looking source reference without fetching or resolving it."""
    value.encode("utf-8", errors="strict")
    if len(value) > 2048 or any(ord(char) <= 32 or ord(char) == 127 for char in value) or "\\" in value:
        raise ValueError("Use a public http or https lesson URL without credentials.")
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    if (parsed.scheme not in {"http", "https"} or parsed.username is not None or parsed.password is not None
            or parsed.port not in {None, 80, 443} or not host or "." not in host
            or host.endswith((".local", ".localhost", ".internal", ".test", ".invalid", ".example", ".home", ".lan"))):
        raise ValueError("Use a public http or https lesson URL without a login or custom port.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("Use a public website URL, not an IP address.")
    if (not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host)
            or re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*", host)
            or any(not label or len(label) > 63 or label.startswith("-") or label.endswith("-") for label in host.split("."))
            or not re.search(r"[a-z]", host.split(".")[-1])):
        raise ValueError("Use a public website URL.")
    if any(re.search(r"token|secret|password|key|signature|credential|authorization", name, re.I)
           for name, _ in parse_qsl(parsed.query)):
        raise ValueError("Do not save credentials in source URLs.")
    return parsed._replace(fragment="").geturl()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)


class ReviewedQuestion(StrictModel):
    label: Annotated[str, StringConstraints(max_length=200), AfterValidator(reviewed_text)] = ""
    text: Text = ""
    latex: Text = ""
    diagram_description: Text = ""
    ambiguities: list[ShortText] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def has_question(self):
        if not self.text and not self.latex:
            raise ValueError("A question needs text or LaTeX.")
        return self


class NotebookRequest(StrictModel):
    title: Annotated[str, StringConstraints(min_length=1, max_length=200), AfterValidator(reviewed_text)]
    sourceType: Literal["manual", "photo", "url", "voice"]
    sourceUrl: str | None = Field(default=None, max_length=2048)
    questions: list[ReviewedQuestion] = Field(min_length=1, max_length=100)
    reviewed: Literal[True]

    @field_validator("reviewed", mode="before")
    @classmethod
    def explicit_review(cls, value):
        if value is not True:
            raise ValueError("Explicit review is required.")
        return value

    @field_validator("sourceUrl")
    @classmethod
    def public_url(cls, value):
        return public_source_url(value) if value is not None else None


class NotebookResponse(NotebookRequest):
    id: str


class NotebookListResponse(BaseModel):
    notebooks: list[NotebookResponse]


class EmptyRequest(StrictModel):
    pass


def create_private_route(authenticate: Callable[..., Any]) -> type[APIRoute]:
    """Authenticate before reading/parsing bounded bodies; sanitize all failures."""
    class PrivateRoute(APIRoute):
        def get_route_handler(self):
            original = super().get_route_handler()

            async def handler(request: Request):
                try:
                    _same_origin(request)
                    await run_in_threadpool(authenticate, request.cookies.get("math_tutor_session"))
                    if request.method not in {"GET", "HEAD"}:
                        path = request.url.path
                        limit = (9 * 1024 * 1024 if path.startswith("/recognize-handwriting") or path == "/voice/transcribe"
                                 else MAX_NOTEBOOK_BYTES if path == "/api/notebooks" else 64 * 1024)
                        if request.headers.get("content-encoding", "identity").lower() != "identity":
                            raise HTTPException(415, "Compressed request bodies are not supported.")
                        lengths = request.headers.getlist("content-length")
                        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,10}", lengths[0])):
                            raise HTTPException(400, "Invalid request length.")
                        if lengths and int(lengths[0]) > limit:
                            raise HTTPException(413, "Request body exceeds the allowed limit.")
                        body = bytearray()
                        try:
                            async with asyncio.timeout(15):
                                async for chunk in request.stream():
                                    if len(body) + len(chunk) > limit:
                                        raise HTTPException(413, "Request body exceeds the allowed limit.")
                                    body.extend(chunk)
                        except TimeoutError:
                            raise HTTPException(408, "Request upload timed out.") from None
                        if lengths and len(body) != int(lengths[0]):
                            raise HTTPException(400, "Request length does not match the body.")
                        if body:
                            if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                                raise HTTPException(415, "Content-Type must be application/json.")
                            try:
                                request._json = _strict_json(body)
                            except (ValueError, TypeError, RecursionError):
                                raise HTTPException(422, "Invalid JSON request.") from None
                        request._body = bytes(body)
                    response = await original(request)
                except StarletteHTTPException as exc:
                    response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
                except RequestValidationError:
                    # Pydantic's default errors echo submitted media/text/credentials.
                    response = JSONResponse({"detail": "Invalid request. Check the reviewed fields and size limits."}, status_code=422)
                except Exception:
                    response = JSONResponse({"detail": "This operation is temporarily unavailable."}, status_code=500)
                response.headers["Cache-Control"] = "no-store"
                return response

            return handler

    return PrivateRoute


def initialize_library(connect: Callable[[], sqlite3.Connection]) -> None:
    with connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS capture_notebooks (
                id TEXT PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id),
                title TEXT NOT NULL,
                source_type TEXT NOT NULL CHECK(source_type IN ('manual', 'photo', 'url', 'voice')),
                source_url TEXT,
                questions_json TEXT NOT NULL,
                reviewed INTEGER NOT NULL CHECK(reviewed = 1),
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS capture_notebooks_owner ON capture_notebooks(student_id, created_at);
        """)


def owned_notebook(db: sqlite3.Connection, notebook_id: str, student_id: int) -> NotebookResponse:
    row = db.execute("SELECT * FROM capture_notebooks WHERE id = ? AND student_id = ?", (notebook_id, student_id)).fetchone()
    if row is None:
        raise HTTPException(404, "Notebook not found.")
    return notebook_response(row)


def notebook_response(row: sqlite3.Row) -> NotebookResponse:
    return NotebookResponse(id=row["id"], title=row["title"], sourceType=row["source_type"], sourceUrl=row["source_url"],
                            questions=json.loads(row["questions_json"]), reviewed=True)


def imported_question(db: sqlite3.Connection, problem_key: str, student_id: int) -> ReviewedQuestion:
    try:
        prefix, notebook_id, raw_index = problem_key.split(":")
        if prefix != "imported" or not raw_index.isdecimal():
            raise ValueError
        notebook = owned_notebook(db, notebook_id, student_id)
        return notebook.questions[int(raw_index)]
    except (ValueError, IndexError):
        raise HTTPException(404, "Imported question not found.") from None


def create_library_router(authenticate: Callable[..., Any], connect: Callable[[], sqlite3.Connection],
                          practice_response_model: type[BaseModel]) -> APIRouter:
    initialize_library(connect)
    router = APIRouter(prefix="/api/notebooks", tags=["Reviewed notebooks"], route_class=create_private_route(authenticate))

    @router.post("", response_model=NotebookResponse, status_code=201)
    def save(value: NotebookRequest, math_tutor_session: str | None = Cookie(default=None)):
        learner = authenticate(math_tutor_session)
        notebook_id = str(uuid4())
        with connect() as db:
            db.execute("""INSERT INTO capture_notebooks
                (id, student_id, title, source_type, source_url, questions_json, reviewed, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)""",
                (notebook_id, learner["id"], value.title, value.sourceType, value.sourceUrl,
                 json.dumps([q.model_dump() for q in value.questions], ensure_ascii=False), int(time.time())))
        return NotebookResponse(id=notebook_id, **value.model_dump())

    @router.get("", response_model=NotebookListResponse)
    def list_notebooks(math_tutor_session: str | None = Cookie(default=None)):
        learner = authenticate(math_tutor_session)
        with connect() as db:
            rows = db.execute("SELECT * FROM capture_notebooks WHERE student_id = ? ORDER BY created_at DESC, rowid DESC",
                              (learner["id"],)).fetchall()
        return NotebookListResponse(notebooks=[notebook_response(row) for row in rows])

    @router.get("/{notebook_id}", response_model=NotebookResponse)
    def get_notebook(notebook_id: str, math_tutor_session: str | None = Cookie(default=None)):
        learner = authenticate(math_tutor_session)
        with connect() as db:
            return owned_notebook(db, notebook_id, learner["id"])

    @router.post("/{notebook_id}/questions/{index}/practice", response_model=practice_response_model, status_code=201)
    def practice(notebook_id: str, index: int, value: EmptyRequest = EmptyRequest(),
                 math_tutor_session: str | None = Cookie(default=None)):
        learner = authenticate(math_tutor_session)
        with connect() as db:
            notebook = owned_notebook(db, notebook_id, learner["id"])
            if index < 0 or index >= len(notebook.questions):
                raise HTTPException(404, "Question not found.")
            question = notebook.questions[index]
            session_id = str(uuid4())
            problem_key = f"imported:{notebook_id}:{index}"
            db.execute("INSERT INTO practice_sessions (id, student_id, problem_key, next_step, created_at) VALUES (?, ?, ?, 0, ?)",
                       (session_id, learner["id"], problem_key, int(time.time())))
        prompt = "\n".join(part for part in (question.label, question.text, question.latex, question.diagram_description) if part)
        return practice_response_model(sessionId=session_id, problemId=problem_key, topic=notebook.title, prompt=prompt,
                                       goal="Work through your reviewed question one step at a time. " + UNGRADED_NOTICE,
                                       foundation=IMPORTED_FOUNDATION, nextStep=0, imported=True,
                                       tutor={"mode": "guided", "prompt": IMPORTED_GUIDANCE})

    return router