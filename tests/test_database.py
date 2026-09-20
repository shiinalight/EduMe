"""PostgreSQL behavior: pooler-safe connection settings, private schema, init command, concurrency."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

import database
import main

ROOT = Path(__file__).resolve().parent.parent
TABLES = {
    "students", "login_sessions", "practice_sessions", "practice_steps", "student_tutor_preferences",
    "tutor_strategy_events", "session_tutor_state", "capture_notebooks", "heygen_video_jobs",
}
FAKE_URL = "postgresql://postgres.abcdef:hunter2-secret@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"


# --- connection settings (no server needed) ---------------------------------------------------

def test_connect_requires_database_url_without_leaking_anything(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(database.DatabaseConfigError, match="DATABASE_URL is not set"):
        database.connect()


def test_connect_uses_ssl_and_disables_prepared_statements_by_default(monkeypatch):
    seen = {}
    monkeypatch.setenv("DATABASE_URL", FAKE_URL + "?sslmode=disable")
    monkeypatch.delenv("DATABASE_SSLMODE", raising=False)
    monkeypatch.setattr(psycopg, "connect", lambda url, **kwargs: seen.update(url=url, **kwargs))
    database.connect()
    assert seen["sslmode"] == "require"  # Even a URL asking for sslmode=disable is overridden.
    assert seen["prepare_threshold"] is None
    assert seen["row_factory"] is psycopg.rows.dict_row


def test_ssl_mode_is_configurable_but_validated(monkeypatch):
    monkeypatch.setenv("DATABASE_SSLMODE", "verify-full")
    assert database.ssl_mode() == "verify-full"
    monkeypatch.setenv("DATABASE_SSLMODE", "yes-please")
    with pytest.raises(database.DatabaseConfigError, match="DATABASE_SSLMODE"):
        database.ssl_mode()


def test_redact_removes_username_and_password_from_messages(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", FAKE_URL)
    message = database.redact('FATAL: password authentication failed for user "postgres.abcdef" (hunter2-secret)')
    assert "hunter2-secret" not in message and "postgres.abcdef" not in message
    assert "authentication failed" in message


# --- real PostgreSQL -------------------------------------------------------------------------

def test_no_server_side_prepared_statements_after_repeated_queries(clean_database):
    with database.connect() as db:
        for _ in range(12):  # psycopg's default would prepare a statement after 5 executions
            db.execute("SELECT 1 AS one WHERE %s = %s", (1, 1)).fetchone()
        assert db.execute("SELECT count(*) AS n FROM pg_prepared_statements").fetchone()["n"] == 0


def test_tables_live_only_in_the_private_schema_with_row_security(clean_database):
    with database.connect() as db:
        found = {row["tablename"]: row["rowsecurity"] for row in db.execute(
            "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = %s", (database.SCHEMA,))}
        in_public = {row["tablename"] for row in db.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}
    assert set(found) == TABLES
    assert all(found.values()), "RLS must be enabled on every private table"
    assert not TABLES & in_public


def test_initialization_is_repeatable_and_preserves_data(clean_database):
    client = TestClient(main.app)
    email = f"{uuid4()}@example.test"
    body = {"fullName": "Repeat Student", "email": email, "password": "repeat-password",
            "grade": 8, "country": "United States", "state": "Oregon"}
    assert client.post("/auth/register", json=body).status_code == 201
    main.initialize_database()
    main.initialize_database()
    assert client.get("/me").json()["email"] == email


def test_importing_the_app_does_not_create_tables(clean_database):
    with database.connect() as db:
        db.execute(f"DROP SCHEMA {database.SCHEMA} CASCADE")
    subprocess.run([sys.executable, "-c", "import main"], cwd=ROOT, check=True, env=os.environ.copy(), capture_output=True)
    with database.connect() as db:
        assert db.execute("SELECT to_regnamespace(%s) AS found", (database.SCHEMA,)).fetchone()["found"] is None


def test_init_command_loads_dotenv_and_creates_schema(clean_database, tmp_path):
    with database.connect() as db:
        db.execute(f"DROP SCHEMA {database.SCHEMA} CASCADE")
    (tmp_path / "init_db.py").write_text((ROOT / "init_db.py").read_text())
    (tmp_path / ".env").write_text(f"DATABASE_URL={os.environ['DATABASE_URL']}\n")
    env = {key: value for key, value in os.environ.items() if key != "DATABASE_URL"}
    env["PYTHONPATH"] = str(ROOT)
    result = subprocess.run([sys.executable, str(tmp_path / "init_db.py")], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert f"{len(TABLES)} tables" in result.stdout
    check = subprocess.run([sys.executable, str(tmp_path / "init_db.py"), "--check"], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert check.returncode == 0 and "No changes made" in check.stdout


def test_init_command_fails_cleanly_without_a_url(tmp_path):
    (tmp_path / "init_db.py").write_text((ROOT / "init_db.py").read_text())
    env = {key: value for key, value in os.environ.items() if key != "DATABASE_URL"}
    env["PYTHONPATH"] = str(ROOT)
    result = subprocess.run([sys.executable, str(tmp_path / "init_db.py")], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert result.returncode == 1
    assert "DATABASE_URL is not set" in result.stderr and "Traceback" not in result.stderr


# --- behavior preserved from the SQLite version -------------------------------------------------

def register(client, email=None, **overrides):
    return client.post("/auth/register", json={
        "fullName": "Postgres Student", "email": email or f"{uuid4()}@example.test", "password": "pg-test-password",
        "grade": 8, "country": "United States", "state": "Oregon", **overrides})


def test_register_login_logout_and_duplicate_email(clean_database):
    client = TestClient(main.app)
    email = f"{uuid4()}@example.test"
    first = register(client, email=f" {email.upper()} ", tutorModes=["socratic", "visual", "socratic"])
    assert first.status_code == 201
    assert first.json()["email"] == email and first.json()["tutorModes"] == ["socratic", "visual"]  # order kept, deduplicated
    assert register(TestClient(main.app), email=email).status_code == 409

    other = TestClient(main.app)
    assert other.post("/auth/login", json={"email": email, "password": "wrong-password"}).status_code == 401
    assert other.post("/auth/login", json={"email": email, "password": "pg-test-password"}).status_code == 200
    assert other.get("/me").json()["id"] == first.json()["id"]
    assert other.post("/auth/logout").status_code == 204
    assert other.get("/me").status_code == 401
    assert client.get("/me").status_code == 200, "logging out one session must not end another"


def test_practice_sessions_are_owner_scoped(clean_database):
    owner, stranger = TestClient(main.app), TestClient(main.app)
    register(owner), register(stranger)
    session = owner.post("/learning-sessions", json={"topicKey": "pythagoras"}).json()
    path = f"/learning-sessions/{session['sessionId']}"
    assert owner.get(f"{path}/review").status_code == 200
    assert stranger.get(f"{path}/review").status_code == 404
    assert stranger.post(f"{path}/steps", json={"rawLatex": "a^2+b^2=c^2", "confidence": 0.9, "timestamp": 1}).status_code == 404


def test_nul_characters_are_rejected_not_a_server_error(clean_database):
    client = TestClient(main.app)
    assert register(client, fullName="Bad\x00Name").status_code == 422
    assert register(client).status_code == 201
    saved = client.post("/api/notebooks", json={"title": "Bad\x00title", "sourceType": "manual", "reviewed": True,
                                                 "questions": [{"text": "1 + 1"}]})
    assert saved.status_code == 422


def test_concurrent_steps_on_an_imported_session_never_reuse_a_step_index(clean_database):
    owner = TestClient(main.app)
    register(owner)
    notebook = owner.post("/api/notebooks", json={"title": "Race", "sourceType": "manual", "reviewed": True,
                                                   "questions": [{"text": "Solve it"}]}).json()
    session = owner.post(f"/api/notebooks/{notebook['id']}/questions/0/practice").json()
    workers = 8
    gate = threading.Barrier(workers)

    def submit(number):
        client = TestClient(main.app)
        client.cookies.update(owner.cookies)
        gate.wait()
        return client.post(f"/learning-sessions/{session['sessionId']}/steps",
                           json={"rawLatex": f"step {number}", "confidence": 0.9, "timestamp": 1}).status_code

    with ThreadPoolExecutor(workers) as pool:
        assert list(pool.map(submit, range(workers))) == [200] * workers
    with database.connect() as db:
        indexes = [row["step_index"] for row in db.execute(
            "SELECT step_index FROM edume_private.practice_steps WHERE practice_session_id = %s ORDER BY step_index",
            (session["sessionId"],))]
        next_step = db.execute("SELECT next_step FROM edume_private.practice_sessions WHERE id = %s",
                               (session["sessionId"],)).fetchone()["next_step"]
    assert indexes == list(range(workers)) and next_step == workers
