"""Test helpers shared by the API test modules.

``account`` / ``auth`` / ``create_project`` reproduce the historical helpers;
the OAuth helpers drive the full Authorization Code + PKCE flow against
whatever TestClient they are given, returning the raw tokens so callers can
assert on them (no raw token is ever persisted server-side).
"""

from __future__ import annotations

import base64
import hashlib
import re
from urllib.parse import parse_qs, urlparse

WEB_REDIRECT = "https://share.example/oauth-callback.html"
DESKTOP_REDIRECT = "org.geolibre.desktop:/oauth/callback"
ORIGIN = "https://share.example"


def account(client, username="ada", password="correct horse", **extra):
    body = {"username": username, "password": password, **extra}
    response = client.post("/api/accounts", json=body)
    assert response.status_code == 201, response.text
    return response.json()["token"]


def ensure_account(client, username="ada", password="correct horse"):
    """Create the credential-bearing account; 409 means it already exists."""
    response = client.post("/api/accounts", json={"username": username, "password": password})
    assert response.status_code in (201, 409), response.text


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def create_project(client, token, visibility="public", title="Wetlands"):
    content = json_dumps({"version": "1.0", "title": title, "layers": []})
    response = client.post(
        "/api/projects",
        headers=auth(token),
        json={
            "filename": "fallback.geolibre.json",
            "content": content,
            "visibility": visibility,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["project"], content


def json_dumps(value) -> str:
    import json

    return json.dumps(value)


def pat(client, username="ada", password="correct horse", **extra):
    """Issue a personal API token through /api/auth/token (custom policy opts).

    Returns the raw token string, matching the ``account`` helper convention.
    """
    ensure_account(client, username, password)
    body = {"username": username, "password": password, **extra}
    response = client.post("/api/auth/token", json=body)
    assert response.status_code == 200, response.text
    return response.json()["token"]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_verifier_and_challenge(seed: bytes = b"v") -> tuple[str, str]:
    verifier = b64url(seed * 48)
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def start_authorize(
    client,
    *,
    client_id="geolibre-web",
    scope="read:projects",
    state=None,
    challenge=None,
    label=None,
    redirect_uri=None,
    params_extra=None,
    follow_redirects=False,
):
    """GET /oauth/authorize and return (page_text, interaction_id, csrf)."""
    ensure_account(client)
    redirect_uri = redirect_uri or (
        DESKTOP_REDIRECT if client_id == "geolibre-desktop" else WEB_REDIRECT
    )
    verifier, computed = make_verifier_and_challenge()
    if challenge is None:
        challenge = computed
    query = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state or "s" * 32,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if label is not None:
        query["device_label"] = label
    if params_extra:
        query.update(params_extra)
    response = client.get("/oauth/authorize", params=query, follow_redirects=follow_redirects)
    interaction = csrf = None
    if response.status_code == 200:
        match = re.search(r"name='interaction' value='([^']+)'", response.text)
        csrf_match = re.search(r"name='csrf' value='([^']+)'", response.text)
        if match and csrf_match:
            interaction, csrf = match.group(1), csrf_match.group(1)
    return response, verifier, interaction, csrf


def approve(
    client,
    interaction,
    csrf,
    *,
    username="ada",
    password="correct horse",
    label="Test device",
    decision="allow",
    origin=ORIGIN,
):
    return client.post(
        "/oauth/authorize",
        data={
            "interaction": interaction,
            "csrf": csrf,
            "label": label,
            "username": username,
            "password": password,
            "decision": decision,
        },
        headers={"Origin": origin},
        follow_redirects=False,
    )


def redirect_params(response) -> dict:
    location = response.headers["location"]
    return {key: values[0] for key, values in parse_qs(urlparse(location).query).items()}


def exchange_code(
    client,
    code,
    *,
    client_id="geolibre-web",
    redirect_uri=None,
    verifier=None,
    extra_form=None,
):
    redirect_uri = redirect_uri or (
        DESKTOP_REDIRECT if client_id == "geolibre-desktop" else WEB_REDIRECT
    )
    data = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code": code,
    }
    if verifier is not None:
        data["code_verifier"] = verifier
    if extra_form:
        data.update(extra_form)
    return client.post(
        "/oauth/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )


def refresh(client, refresh_token, *, client_id="geolibre-web", extra_form=None):
    data = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
    }
    if extra_form:
        data.update(extra_form)
    return client.post(
        "/oauth/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )


def sign_in(
    client,
    *,
    client_id="geolibre-web",
    scope="read:projects",
    username="ada",
    password="correct horse",
    label="Test device",
):
    """The full happy path: authorize -> approve -> exchange -> tokens dict."""
    ensure_account(client, username, password)
    response, verifier, interaction, csrf = start_authorize(
        client, client_id=client_id, scope=scope
    )
    assert response.status_code == 200, response.text
    assert interaction and csrf, "consent form missing interaction/csrf"
    approved = approve(client, interaction, csrf, username=username, password=password, label=label)
    assert approved.status_code == 303, (approved.status_code, approved.text[:200])
    code = redirect_params(approved)["code"]
    exchanged = exchange_code(client, code, client_id=client_id, verifier=verifier)
    assert exchanged.status_code == 200, (exchanged.status_code, exchanged.text)
    return exchanged.json()
