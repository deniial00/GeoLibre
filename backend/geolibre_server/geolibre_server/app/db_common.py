"""Shared database target, error, JSON, and feature-diff helpers."""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from fastapi import HTTPException

UNRESTRICTED = "*"
_PASSWORD_URL_RE = re.compile(r"(://[^:/\s@]*:)[^\s]+@")
_PASSWORD_KV_RE = re.compile(
    r"(?i)(\b(?:password|pwd|client_secret|access_token)\s*=\s*)('[^']*'|\{(?:[^}]|\}\})*\}|[^\s]+)"
)


def normalize_host(host: str) -> str:
    candidate = host.strip()
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    if not candidate or candidate.startswith("/"):
        raise ValueError("host must be a TCP hostname or IP address")
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return candidate.rstrip(".").lower()


def parse_host_allowlist(value: str) -> Optional[set[tuple[str, Optional[int]]]]:
    entries = [entry.strip() for entry in value.split(",") if entry.strip()]
    if UNRESTRICTED in entries:
        if len(entries) > 1:
            raise ValueError(f"'{UNRESTRICTED}' must be the only entry")
        return None
    targets: set[tuple[str, Optional[int]]] = set()
    for entry in entries:
        host, port = entry, None
        if entry.startswith("["):
            closing = entry.find("]")
            if closing < 0:
                raise ValueError("invalid bracketed IPv6 address")
            host, suffix = entry[1:closing], entry[closing + 1 :]
            if suffix:
                if not suffix.startswith(":"):
                    raise ValueError("invalid characters after IPv6 address")
                port = int(suffix[1:])
        elif entry.count(":") == 1:
            host, port_text = entry.rsplit(":", 1)
            port = int(port_text)
        elif entry.count(":") > 1:
            raise ValueError("IPv6 entries must be bracketed, e.g. [2001:db8::1]:5432")
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("port must be between 1 and 65535")
        targets.add((normalize_host(host), port))
    return targets


def allowlist_from_env(
    env_var: str, disabled_detail: str
) -> Optional[set[tuple[str, Optional[int]]]]:
    import os

    try:
        allowed = parse_host_allowlist(os.environ.get(env_var, ""))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"{env_var} is invalid") from exc
    if allowed == set():
        raise HTTPException(status_code=403, detail=disabled_detail)
    return allowed


def host_port_allowed(
    allowed: set[tuple[str, Optional[int]]], host: str, port: Optional[int]
) -> bool:
    host = normalize_host(host)
    return (host, port) in allowed or (host, None) in allowed


def scrub_secrets(message: str, secrets: Iterable[str] = ()) -> str:
    scrubbed = _PASSWORD_URL_RE.sub(r"\1****@", message)
    scrubbed = _PASSWORD_KV_RE.sub(r"\1****", scrubbed)
    for secret in secrets:
        if secret:
            scrubbed = scrubbed.replace(secret, "****")
    return scrubbed


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (bool, float, str)):
        return value
    if isinstance(value, int):
        return value if -(2**53) < value < 2**53 else str(value)
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (bytes, memoryview)):
        return bytes(value).hex()
    return str(value)


def require_features(geojson: Optional[dict]) -> list[dict]:
    from geolibre_server import vector_ops

    features = geojson.get("features") if geojson else None
    if not isinstance(features, list) or not features:
        raise HTTPException(status_code=400, detail="No features to write.")
    if len(features) > vector_ops.MAX_FEATURES:
        raise HTTPException(
            status_code=413, detail=f"Layer exceeds the {vector_ops.MAX_FEATURES}-feature limit"
        )
    return features


@dataclass(frozen=True)
class RowChange:
    key: Any
    geometry: Optional[dict]
    values: dict[str, Any]


@dataclass(frozen=True)
class FeatureDiff:
    updates: list[RowChange]
    inserts: list[RowChange]
    deletes: list[Any]
    skipped_fields: list[str]


def plan_feature_diff(
    features: list[dict],
    *,
    primary_key: str,
    writable_columns: list[str],
    existing_rows: dict[Any, tuple[Optional[dict], dict[str, Any]]],
    pk_is_generated: bool,
    insert_explicit_key: bool,
    baseline_keys: Optional[list],
    capabilities: Optional[dict[str, bool]],
    table_label: str,
) -> FeatureDiff:
    writable = set(writable_columns)
    existing = set(existing_rows)
    kept: set[Any] = set()
    updates: list[RowChange] = []
    inserts: list[RowChange] = []
    skipped: set[str] = set()
    caps = capabilities or {}
    for feature in features:
        properties = feature.get("properties") or {}
        skipped.update(key for key in properties if key not in writable and key != primary_key)
        columns = [column for column in writable_columns if column in properties]
        values = {column: properties[column] for column in columns}
        geometry = feature.get("geometry")
        key = properties.get(primary_key)
        if key is None:
            key = feature.get("id")
        if key is None and not pk_is_generated:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Feature without a '{primary_key}' value cannot be inserted: "
                    f"{table_label}'s primary key has no default or identity."
                ),
            )
        if key is not None and key in existing:
            kept.add(key)
            stored_geometry, stored_values = existing_rows[key]
            if geometry == stored_geometry and all(
                properties[column] == stored_values.get(column) for column in columns
            ):
                continue
            if not caps.get("update", True):
                raise HTTPException(
                    status_code=403, detail="Layer capability excludes feature updates."
                )
            updates.append(RowChange(key, geometry, values))
        else:
            if not caps.get("create", True):
                raise HTTPException(
                    status_code=403, detail="Layer capability excludes feature creation."
                )
            explicit_key = key if key is not None and insert_explicit_key else None
            if explicit_key is not None:
                kept.add(explicit_key)
            inserts.append(RowChange(explicit_key, geometry, values))
    deletable = existing if baseline_keys is None else existing & set(baseline_keys)
    deletes = sorted(deletable - kept, key=str)
    if deletes and not caps.get("delete", True):
        raise HTTPException(status_code=403, detail="Layer capability excludes feature deletion.")
    return FeatureDiff(updates, inserts, deletes, sorted(skipped))
