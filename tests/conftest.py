"""Offline backend suite: isolate the database before test collection imports main.

Database tests need a disposable PostgreSQL server, given as TEST_DATABASE_URL, e.g.
    TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/edume_test pytest
Tests never read DATABASE_URL and refuse Supabase hosts: they drop and rebuild the
private schema before every test that uses the ``clean_database`` fixture.
"""
import os
import socket

import httpx
import pytest


TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "").strip()

if TEST_DATABASE_URL and ("supabase" in TEST_DATABASE_URL.lower() or TEST_DATABASE_URL == os.environ.get("DATABASE_URL")):
    pytest.exit("TEST_DATABASE_URL must be a disposable local database, not the app's real (or any Supabase) database.", returncode=2)

_environment = pytest.MonkeyPatch()
_environment.delenv("DATABASE_URL", raising=False)
_environment.delenv("DATABASE_SSLMODE", raising=False)
if TEST_DATABASE_URL:
    _environment.setenv("DATABASE_URL", TEST_DATABASE_URL)
    # A local test server usually has no TLS; production defaults to "require".
    _environment.setenv("DATABASE_SSLMODE", os.environ.get("TEST_DATABASE_SSLMODE", "prefer"))


def pytest_unconfigure(config):
    _environment.undo()


@pytest.fixture
def clean_database():
    """Drop and recreate the private schema so each test starts empty."""
    if not TEST_DATABASE_URL:
        pytest.fail("Set TEST_DATABASE_URL to a disposable local PostgreSQL database (see tests/conftest.py).", pytrace=False)
    import database
    import main

    with database.connect() as db:
        db.execute(f"DROP SCHEMA IF EXISTS {database.SCHEMA} CASCADE")
    main.initialize_database()


@pytest.fixture(autouse=True)
def offline_providers(monkeypatch):
    for name in ("GEMINI_API_KEY", "GEMINI_MODEL", "ELEVENLABS_API_KEY", "FIRECRAWL_API_KEY", "HEYGEN_API_KEY",
                 "INKMATH_OCR_URL", "TEAM_OCR_URL", "OCR_SERVICE_URL"):
        monkeypatch.delenv(name, raising=False)

    def forbidden(*args, **kwargs):
        pytest.fail("Unmocked outbound connection: use an explicit provider mock")

    async def async_forbidden(*args, **kwargs):
        forbidden()

    original_connect = socket.socket.connect

    def connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            forbidden()
        return original_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", forbidden)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", async_forbidden)
