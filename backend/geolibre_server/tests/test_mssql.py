"""Unit and opt-in live integration tests for SQL Server editable layers."""

from __future__ import annotations

import os
import struct
import time

import pytest
from fastapi import HTTPException

from geolibre_server.app import mssql

try:
    import pyodbc

    HAS_PYODBC = True
except Exception:
    pyodbc = None
    HAS_PYODBC = False

HAS_DRIVER = False
if HAS_PYODBC:
    try:
        HAS_DRIVER = bool(mssql._select_driver(pyodbc))
    except Exception:
        pass
LIVE = HAS_PYODBC and HAS_DRIVER and bool(os.environ.get("GEOLIBRE_TEST_MSSQL_SERVER"))
requires_live_mssql = pytest.mark.skipif(
    not LIVE, reason="GEOLIBRE_TEST_MSSQL_SERVER not set or ODBC driver missing"
)
if os.environ.get("GEOLIBRE_TEST_MSSQL_REQUIRED") == "1" and not LIVE:
    raise RuntimeError("SQL Server integration prerequisites missing")


def test_connection_string_escapes_credentials():
    auth = mssql.MssqlAuth(method="sql", username="alice", password="a}b")
    value = mssql._build_connection_string(
        "ODBC Driver 18 for SQL Server", "db.example", None, 1433, "gis", True, False, auth
    )
    assert "PWD={a}}b}" in value
    assert "SERVER=tcp:db.example,1433" in value


def test_server_target_and_allowlist(monkeypatch):
    monkeypatch.setenv("GEOLIBRE_MSSQL_HOSTS", "db.example:1433")
    req = mssql.MssqlConnectRequest(
        server="db.example",
        database="gis",
        auth={"method": "sql", "username": "u", "password": "p"},
    )
    assert mssql._validate_target(req) == ("db.example", None)
    with pytest.raises(HTTPException) as exc:
        mssql._validate_target(req.model_copy(update={"server": "db.example\\instance"}))
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        mssql._parse_server("a;b")
    assert exc.value.status_code == 400
    monkeypatch.setenv("GEOLIBRE_MSSQL_HOSTS", "db.example")
    assert mssql._validate_target(req.model_copy(update={"server": "db.example\\instance"})) == (
        "db.example",
        "instance",
    )
    monkeypatch.delenv("GEOLIBRE_MSSQL_HOSTS")
    with pytest.raises(HTTPException) as exc:
        mssql._validate_target(req)
    assert exc.value.status_code == 403


def test_auth_methods_desktop_gate(monkeypatch):
    monkeypatch.setattr(mssql, "azure_identity_import_error", lambda: None)
    monkeypatch.delenv("GEOLIBRE_MSSQL_DESKTOP_AUTH", raising=False)
    assert "windows" not in mssql.available_auth_methods()
    assert "entra_interactive" not in mssql.available_auth_methods()
    monkeypatch.setenv("GEOLIBRE_MSSQL_DESKTOP_AUTH", "1")
    monkeypatch.setattr(mssql.sys, "platform", "win32")
    methods = mssql.available_auth_methods()
    assert "windows" in methods and "entra_interactive" in methods


def test_status_driver_missing(monkeypatch):
    class Fake:
        @staticmethod
        def drivers():
            return []

    monkeypatch.setattr(mssql, "pyodbc_import_error", lambda: None)
    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    result = mssql.mssql_status()
    assert not result["available"]
    assert result["message"] == "Microsoft ODBC Driver 18 for SQL Server is not installed."


def test_token_refreshed_each_connection(monkeypatch):
    class Credential:
        def __init__(self):
            self.count = 0

        def get_token(self, scope):
            self.count += 1
            return type("Token", (), {"token": f"t{self.count}"})()

    calls = []

    class Conn:
        def __setattr__(self, key, value):
            object.__setattr__(self, key, value)

    class Fake:
        @staticmethod
        def connect(cs, **kwargs):
            calls.append(kwargs)
            return Conn()

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    cred = Credential()
    session = mssql._Session("cs", cred, None, (), time.monotonic())
    mssql._open_connection(session)
    mssql._open_connection(session)

    def packed(token):
        raw = token.encode("utf-16-le")
        return struct.pack(f"<I{len(raw)}s", len(raw), raw)

    assert calls[0]["attrs_before"][1256] == packed("t1")
    assert calls[1]["attrs_before"][1256] == packed("t2")


def test_connect_failure_scrubs_secret(monkeypatch):
    monkeypatch.setattr(
        mssql, "_require_runtime", lambda: (object(), "ODBC Driver 18 for SQL Server")
    )
    monkeypatch.setattr(mssql, "_validate_target", lambda req: ("db.example", None))
    monkeypatch.setattr(mssql, "available_auth_methods", lambda: ["sql"])

    class Fake:
        @staticmethod
        def connect(*a, **kw):
            raise Exception("Login failed PWD={sekret}; token sekret")

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    req = mssql.MssqlConnectRequest(
        server="db.example",
        database="gis",
        auth={"method": "sql", "username": "u", "password": "sekret"},
    )
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_connect(req)
    assert "sekret" not in exc.value.detail
    assert "****" in exc.value.detail


def test_connect_success_returns_only_session_id(monkeypatch):
    monkeypatch.setattr(
        mssql, "_require_runtime", lambda: (object(), "ODBC Driver 18 for SQL Server")
    )
    monkeypatch.setattr(mssql, "_validate_target", lambda req: ("db.example", None))
    monkeypatch.setattr(mssql, "available_auth_methods", lambda: ["sql"])

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def execute(self, query):
            assert query == "SELECT 1"

    class Connection:
        timeout = None

        def cursor(self):
            return Cursor()

        def close(self):
            pass

    class Fake:
        @staticmethod
        def connect(*args, **kwargs):
            return Connection()

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    with mssql._SESSIONS_LOCK:
        mssql._SESSIONS.clear()
    req = mssql.MssqlConnectRequest(
        server="db.example",
        database="gis",
        auth={"method": "sql", "username": "u", "password": "p"},
    )
    result = mssql.mssql_connect(req)
    assert set(result) == {"session_id"}
    mssql.mssql_disconnect(mssql.MssqlSessionRequest(session_id=result["session_id"]))


def test_session_unknown_and_idle_expiry(monkeypatch):
    with mssql._SESSIONS_LOCK:
        mssql._SESSIONS.clear()
    with pytest.raises(HTTPException) as exc:
        mssql._get_session("missing")
    assert exc.value.status_code == 410
    mssql._SESSIONS["old"] = mssql._Session("", None, None, (), 0)
    monkeypatch.setattr(mssql.time, "monotonic", lambda: mssql._SESSION_IDLE_S + 1)
    with pytest.raises(HTTPException) as exc:
        mssql._get_session("old")
    assert exc.value.status_code == 410
    with mssql._SESSIONS_LOCK:
        mssql._SESSIONS.clear()


def test_optional_imports_and_runtime_errors(monkeypatch):
    monkeypatch.setattr(mssql, "pyodbc_import_error", lambda: "missing")
    with pytest.raises(HTTPException) as exc:
        mssql._require_runtime()
    assert exc.value.status_code == 503


@pytest.fixture
def live_db(monkeypatch):
    server = os.environ["GEOLIBRE_TEST_MSSQL_SERVER"]
    database = os.environ.get("GEOLIBRE_TEST_MSSQL_DATABASE", "master")
    user = os.environ["GEOLIBRE_TEST_MSSQL_USER"]
    password = os.environ["GEOLIBRE_TEST_MSSQL_PASSWORD"]
    mssql._SESSIONS.clear()
    auth = mssql.MssqlAuth(method="sql", username=user, password=password)
    req = mssql.MssqlConnectRequest(
        server=server, database=database, auth=auth, trust_server_certificate=True
    )
    monkeypatch.setenv("GEOLIBRE_MSSQL_HOSTS", os.environ.get("GEOLIBRE_MSSQL_HOSTS", server))
    sid = mssql.mssql_connect(req)["session_id"]
    session = mssql._get_session(sid)
    conn = mssql._open_connection(session)
    cur = conn.cursor()
    cur.execute(
        "IF OBJECT_ID('dbo.geolibre_writeback_test','U') IS NOT NULL "
        "DROP TABLE dbo.geolibre_writeback_test"
    )
    cur.execute(
        "IF OBJECT_ID('dbo.geolibre_writeback_geog','U') IS NOT NULL "
        "DROP TABLE dbo.geolibre_writeback_geog"
    )
    cur.execute(
        "IF OBJECT_ID('dbo.geolibre_writeback_nopk','U') IS NOT NULL "
        "DROP TABLE dbo.geolibre_writeback_nopk"
    )
    cur.execute(
        "CREATE TABLE dbo.geolibre_writeback_test (gid int IDENTITY PRIMARY KEY, "
        "name nvarchar(100) NOT NULL, population int, geom geometry)"
    )
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_test(name,population,geom) VALUES "
        "('Knoxville',190000,geometry::Point(-9342009.589714656,4295201.3456280865,3857)),"
        "('Second',2,geometry::Point(-9000000,4000000,3857)),"
        "('Third',3,geometry::Point(-8000000,3500000,3857))"
    )
    cur.execute(
        "CREATE TABLE dbo.geolibre_writeback_geog (id uniqueidentifier DEFAULT NEWID() "
        "PRIMARY KEY, name nvarchar(100), geog geography)"
    )
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_geog(name,geog) VALUES "
        "('Knoxville',geography::Point(35.9606,-83.9207,4326))"
    )
    cur.execute("CREATE TABLE dbo.geolibre_writeback_nopk (name nvarchar(20), geom geometry)")
    conn.commit()
    conn.close()
    try:
        yield sid
    finally:
        conn = mssql._open_connection(mssql._get_session(sid))
        cur = conn.cursor()
        for name in (
            "geolibre_writeback_test",
            "geolibre_writeback_geog",
            "geolibre_writeback_nopk",
        ):
            cur.execute(f"DROP TABLE dbo.{name}")
        conn.commit()
        conn.close()
        mssql.mssql_disconnect(mssql.MssqlSessionRequest(session_id=sid))


@requires_live_mssql
def test_live_tables_read_and_geography_axis_order(live_db):
    tables = mssql.mssql_tables(mssql.MssqlSessionRequest(session_id=live_db))["tables"]
    table = next(t for t in tables if t["table"] == "geolibre_writeback_test")
    assert (table["primary_key"], table["srid"], table["column_type"]) == ("gid", 3857, "geometry")
    assert next(t for t in tables if t["table"] == "geolibre_writeback_nopk")["primary_key"] is None
    result = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    feature = next(
        f for f in result["geojson"]["features"] if f["properties"]["name"] == "Knoxville"
    )
    assert feature["id"] == feature["properties"]["gid"]
    x, y = feature["geometry"]["coordinates"]
    assert abs(x + 83.9207) < 1e-4 and abs(y - 35.9606) < 1e-4
    geog = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_geog")
    )
    coords = geog["geojson"]["features"][0]["geometry"]["coordinates"]
    assert coords == pytest.approx([-83.9207, 35.9606], abs=1e-5)


@requires_live_mssql
def test_live_write_roundtrip_and_unchanged_save(live_db):
    request = mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    read = mssql.mssql_read(request)
    original = read["geojson"]
    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=live_db, table="geolibre_writeback_test", geojson=original
        )
    )
    assert (result["updated"], result["inserted"], result["deleted"]) == (0, 0, 0)
    features = original["features"]
    features[0]["properties"]["name"] = "Changed"
    features.pop(1)
    features.append(
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [-83.9, 35.9]},
            "properties": {"name": "New", "population": 5},
        }
    )
    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=live_db,
            table="geolibre_writeback_test",
            geojson=original,
            baseline_keys=[f["id"] for f in read["geojson"]["features"]],
        )
    )
    assert (result["updated"], result["inserted"], result["deleted"]) == (1, 1, 1)


@requires_live_mssql
def test_live_write_rolls_back_capabilities_and_identity_key(live_db):
    read = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    features = read["geojson"]["features"]
    original = features[0]["properties"]["name"]
    features[0]["properties"]["name"] = "Transient"
    features[1]["properties"]["name"] = None
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id=live_db,
                table="geolibre_writeback_test",
                geojson={"type": "FeatureCollection", "features": features},
            )
        )
    assert exc.value.status_code == 400
    fresh = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    assert fresh["geojson"]["features"][0]["properties"]["name"] == original
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id=live_db,
                table="geolibre_writeback_test",
                geojson={
                    "type": "FeatureCollection",
                    "features": fresh["geojson"]["features"][:-1],
                },
                capabilities={"delete": False},
            )
        )
    assert exc.value.status_code == 403
    fresh = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    fresh["geojson"]["features"].append(
        {
            "type": "Feature",
            "id": 9999,
            "geometry": None,
            "properties": {"gid": 9999, "name": "Explicit"},
        }
    )
    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=live_db, table="geolibre_writeback_test", geojson=fresh["geojson"]
        )
    )
    assert result["inserted"] == 1
    assert all(
        f["properties"]["gid"] != 9999
        for f in mssql.mssql_read(
            mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
        )["geojson"]["features"]
    )


@requires_live_mssql
def test_live_geography_polygon_is_oriented(live_db):
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [[-83.9, 35.9], [-83.9, 36.0], [-84.0, 36.0], [-84.0, 35.9], [-83.9, 35.9]]
        ],
    }
    conn = mssql._open_connection(mssql._get_session(live_db))
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_geog(name,geog) "
        "VALUES (?, geography::STGeomFromWKB(?,4326))",
        ("Polygon", mssql._geojson_to_wkb(polygon, 4326, "geography")),
    )
    conn.commit()
    cur.execute("SELECT geog.STArea() FROM dbo.geolibre_writeback_geog WHERE name='Polygon'")
    assert cur.fetchone()[0] < 1e10
    conn.close()
