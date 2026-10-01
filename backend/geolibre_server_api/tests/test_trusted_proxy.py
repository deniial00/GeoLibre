"""Trusted-header proxy sign-in on the OAuth consent page."""

from __future__ import annotations

import json

import pytest
from conftest import OAUTH_CLIENTS, PUBLIC_URL, _make_app
from fastapi.testclient import TestClient
from helpers import approve, auth, exchange_code, redirect_params, start_authorize

PROXY_USER = {"Remote-User": "grace@example.org", "Remote-Email": "grace@example.org"}


@pytest.fixture
def proxied_app(tmp_path, monkeypatch, clock, fake_idp):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    monkeypatch.setenv("GEOLIBRE_TRUSTED_PROXIES", "10.0.0.0/8")
    return _make_app(tmp_path, PUBLIC_URL, clock=clock.now, oidc_transport=fake_idp.transport)


def _proxy_sign_in(client) -> dict:
    page, verifier, interaction, csrf = start_authorize(client)
    assert page.status_code == 200, page.text
    assert "Signed in through your organization's proxy as" in page.text
    assert "name='password'" not in page.text
    approved = approve(client, interaction, csrf, username="", password="")
    assert approved.status_code == 303, approved.text
    exchanged = exchange_code(client, redirect_params(approved)["code"], verifier=verifier)
    assert exchanged.status_code == 200, exchanged.text
    me = client.get("/api/users/me", headers=auth(exchanged.json()["access_token"]))
    assert me.status_code == 200, me.text
    return me.json()["user"]


def test_trusted_proxy_user_signs_in_without_a_password(proxied_app):
    with TestClient(
        proxied_app, base_url=PUBLIC_URL, client=("10.0.0.5", 5000), headers=PROXY_USER
    ) as proxy:
        user = _proxy_sign_in(proxy)
        assert user["username"] == "grace"
        assert user["email"] == "grace@example.org"
        # The proxy identity links to the same account next time.
        assert _proxy_sign_in(proxy)["id"] == user["id"]


def test_untrusted_peer_identity_headers_are_ignored(proxied_app):
    with TestClient(
        proxied_app, base_url=PUBLIC_URL, client=("192.0.2.1", 5000), headers=PROXY_USER
    ) as direct:
        page, _, interaction, csrf = start_authorize(direct)
        assert page.status_code == 200
        assert "name='password'" in page.text
        assert "proxy" not in page.text
        rejected = approve(direct, interaction, csrf, username="", password="")
        assert rejected.status_code == 200
        assert "Invalid username or password" in rejected.text


def test_control_characters_in_proxy_user_are_rejected(proxied_app):
    with TestClient(
        proxied_app,
        base_url=PUBLIC_URL,
        client=("10.0.0.5", 5000),
        headers={"Remote-User": "a\x01b"},
    ) as proxy:
        page, *_ = start_authorize(proxy)
    assert page.status_code == 400
    assert "invalid proxy identity" in page.text
