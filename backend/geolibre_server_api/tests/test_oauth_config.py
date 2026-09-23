"""OAuth startup validation, host binding, and SQLite lock handling."""

from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.main import FileStorage, create_app
from helpers import sign_in

PUBLIC_URL = "https://share.example"
VALID_CLIENTS = [
    {
        "client_id": "geolibre-web",
        "name": "GeoLibre Web",
        "redirect_uris": [f"{PUBLIC_URL}/oauth-callback.html"],
        "scopes": ["read:projects", "write:projects", "share:public"],
    }
]


def make_app(tmp_path, database_url=None, public_url=PUBLIC_URL):
    return create_app(
        database_url or f"sqlite:///{tmp_path / 'test.db'}",
        public_url=public_url,
        storage=FileStorage(str(tmp_path / "objects")),
    )


def test_disabled_oauth_ignores_oauth_only_configuration(tmp_path, monkeypatch):
    monkeypatch.delenv("GEOLIBRE_OAUTH_CLIENTS", raising=False)
    monkeypatch.setenv("GEOLIBRE_OAUTH_ACCESS_TTL_SECONDS", "not-an-integer")
    app = make_app(tmp_path, public_url="not-an-oauth-issuer")
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/.well-known/oauth-authorization-server").status_code == 404


@pytest.mark.parametrize(
    "issuer",
    [
        "https:///missing-host",
        "http://localhost/no-explicit-port",
        "https://share.example:bad-port",
        "ftp://share.example",
    ],
)
def test_enabled_oauth_rejects_invalid_issuers(tmp_path, monkeypatch, issuer):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(VALID_CLIENTS))
    with pytest.raises(RuntimeError, match="GEOLIBRE_PUBLIC_URL"):
        make_app(tmp_path, public_url=issuer)


@pytest.mark.parametrize(
    "client",
    [
        {
            "client_id": "geolibre-web",
            "name": "Web",
            "redirect_uris": ["https:///oauth-callback.html"],
            "scopes": ["read:projects"],
        },
        {
            "client_id": "geolibre-web",
            "name": "Web",
            "redirect_uris": ["http://localhost/oauth-callback.html"],
            "scopes": ["read:projects"],
        },
        {
            "client_id": "geolibre-web",
            "name": "Web",
            "redirect_uris": ["https://share.example/not-the-callback"],
            "scopes": ["read:projects"],
        },
        {
            "client_id": "geolibre-desktop",
            "name": "Desktop",
            "redirect_uris": ["org.geolibre.desktop:/other"],
            "scopes": ["read:projects"],
        },
    ],
)
def test_registration_rejects_unsafe_redirects(tmp_path, monkeypatch, client):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps([client]))
    with pytest.raises(RuntimeError, match="redirect_uri"):
        make_app(tmp_path)


def test_oauth_host_binding_includes_the_issuer_port(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(VALID_CLIENTS))
    app = make_app(tmp_path, public_url="https://share.example:8443")
    with TestClient(app, base_url="https://share.example:8443") as client:
        assert client.get("/.well-known/oauth-authorization-server").status_code == 200
        rejected = client.get(
            "/.well-known/oauth-authorization-server",
            headers={"Host": "share.example"},
        )
        assert rejected.status_code == 400


def test_sqlite_lock_exhaustion_is_a_controlled_oauth_error(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(VALID_CLIENTS))
    database = tmp_path / "locked.db"
    app = make_app(tmp_path, f"sqlite:///{database}?timeout=0.05")
    with TestClient(app, base_url=PUBLIC_URL) as client:
        tokens = sign_in(client)
        lock = sqlite3.connect(database)
        try:
            lock.execute("BEGIN EXCLUSIVE")
            refresh_response = client.post(
                "/oauth/token",
                data={
                    "grant_type": "refresh_token",
                    "client_id": "geolibre-web",
                    "refresh_token": tokens["refresh_token"],
                },
            )
            revoke_response = client.post(
                "/oauth/revoke",
                data={
                    "client_id": "geolibre-web",
                    "token": tokens["access_token"],
                },
            )
        finally:
            lock.rollback()
            lock.close()
    assert refresh_response.status_code == 503
    assert refresh_response.json() == {"error": "temporarily_unavailable"}
    assert revoke_response.status_code == 503
    assert revoke_response.json() == {"error": "temporarily_unavailable"}
