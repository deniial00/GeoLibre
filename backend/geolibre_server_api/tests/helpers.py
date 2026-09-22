"""Helpers shared by the projects-and-identity API tests."""

from __future__ import annotations

import json


def account(client, username="ada", password="correct horse", **extra):
    response = client.post(
        "/api/accounts",
        json={"username": username, "password": password, **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()["token"]


def ensure_account(client, username="ada", password="correct horse"):
    response = client.post("/api/accounts", json={"username": username, "password": password})
    assert response.status_code in (201, 409), response.text


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def create_project(client, token, visibility="public", title="Wetlands"):
    content = json.dumps({"version": "1.0", "title": title, "layers": []})
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


def pat(client, username="ada", password="correct horse", **extra):
    ensure_account(client, username, password)
    response = client.post(
        "/api/auth/token",
        json={"username": username, "password": password, **extra},
    )
    assert response.status_code == 200, response.text
    return response.json()["token"]
