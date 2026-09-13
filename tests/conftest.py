"""Offline backend suite: isolate the database before test collection imports main."""
import os
import socket
from tempfile import TemporaryDirectory

import httpx
import pytest


_database_directory = TemporaryDirectory(prefix="inkmath-backend-tests-")
_environment = pytest.MonkeyPatch()
_environment.setenv("MATH_TUTOR_DB", os.path.join(_database_directory.name, "collection.sqlite3"))


def pytest_unconfigure(config):
    _environment.undo()
    _database_directory.cleanup()


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