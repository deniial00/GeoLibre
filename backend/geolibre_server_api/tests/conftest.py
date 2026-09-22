"""Shared fixtures for the projects-and-identity API test suite."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.main import FileStorage, create_app

PUBLIC_URL = "https://share.example"


class TestClock:
    """Mutable clock for deterministic personal-token expiry tests."""

    def __init__(self, start: int = 1_700_000_000):
        self.now_ts = start

    def now(self) -> int:
        return self.now_ts

    def advance(self, seconds: int) -> None:
        self.now_ts += seconds


@pytest.fixture
def clock() -> TestClock:
    return TestClock()


@pytest.fixture
def client(tmp_path, clock):
    app = create_app(
        f"sqlite:///{tmp_path / 'test.db'}",
        public_url=PUBLIC_URL,
        storage=FileStorage(str(tmp_path / "objects")),
        clock=clock.now,
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def postgres_url():
    """Return the disposable PostgreSQL DSN required by the concurrency gate."""
    import os

    url = os.getenv("GEOLIBRE_TEST_POSTGRES_URL")
    if not url:
        pytest.fail(
            "GEOLIBRE_TEST_POSTGRES_URL is required for postgres-marked tests "
            "(see backend/geolibre_server_api/tests/conftest.py)"
        )
    return url


@pytest.fixture
def postgres_app(tmp_path, postgres_url):
    """Create the API in a unique disposable PostgreSQL schema."""
    import uuid

    from sqlalchemy import create_engine, text

    schema = f"geolibre_test_{uuid.uuid4().hex[:12]}"
    admin = create_engine(postgres_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    app = None
    try:
        option = f"-csearch_path={schema},public"
        quoted = option.replace("=", "%3D").replace(",", "%2C")
        separator = "&" if "?" in postgres_url else "?"
        app = create_app(
            f"{postgres_url}{separator}options={quoted}",
            public_url=PUBLIC_URL,
            storage=FileStorage(str(tmp_path / "objects")),
        )
        yield app
    finally:
        if app is not None:
            app.state.engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
