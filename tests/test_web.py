"""Flask app tests: the shared-password gate, /api/entries snapshot serving,
and the missing-file empty-pool fallback (must be 200, never 500).

SESSION_COOKIE_SECURE is True (correct for prod behind TLS), so the Werkzeug
test client only re-sends the session cookie over https — hence base_url=HTTPS.
"""

import json

import pytest

from babypool.web import create_app

PASSWORD = "correct horse battery staple"
HTTPS = "https://localhost"

SNAPSHOT = {
    "updated_at": "2026-07-17T22:03:02Z",
    "baby": {"parents": ["First", "Second"], "label": "The Baby Pool"},
    "entries": [
        {"name": "Abbey & Warren", "datetime": "2026-08-20T06:00:00",
         "date_label": "Aug 20, 2026", "time_label": "6:00 AM"},
        {"name": "John Heller", "datetime": "2026-08-20T06:00:00",
         "date_label": "Aug 20, 2026", "time_label": "6:00 AM"},
    ],
}


def _write_snapshot(data_dir, obj):
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "entries.json").write_text(json.dumps(obj), encoding="utf-8")


def _clear_gate_env(monkeypatch):
    monkeypatch.delenv("APP_HOST", raising=False)


@pytest.fixture
def gated_app(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", PASSWORD)
    monkeypatch.setenv("SESSION_SECRET", "unit-test-session-secret")
    _clear_gate_env(monkeypatch)
    data_dir = tmp_path / "data"
    _write_snapshot(data_dir, SNAPSHOT)
    return create_app(data_dir=data_dir)


def _login(client, password=PASSWORD, next_target=None):
    data = {"password": password}
    if next_target is not None:
        data["next"] = next_target
    return client.post("/login", data=data, base_url=HTTPS)


# -- gate on ----------------------------------------------------------------

def test_unauth_root_redirects_to_login(gated_app):
    resp = gated_app.test_client().get("/", base_url=HTTPS)
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]


def test_healthz_exempt_no_auth(gated_app):
    resp = gated_app.test_client().get("/healthz", base_url=HTTPS)
    assert resp.status_code == 200
    assert resp.data == b"ok"


def test_static_exempt(gated_app):
    # app.js is a real static file → 200 without auth proves static is exempt.
    resp = gated_app.test_client().get("/static/app.js", base_url=HTTPS)
    assert resp.status_code == 200


def test_correct_password_then_root_ok(gated_app):
    client = gated_app.test_client()
    resp = _login(client)
    assert resp.status_code == 302
    assert client.get("/", base_url=HTTPS).status_code == 200


def test_wrong_password_401_and_still_gated(gated_app):
    client = gated_app.test_client()
    assert _login(client, password="nope").status_code == 401
    assert client.get("/", base_url=HTTPS).status_code == 302


def test_rate_limit_trips_after_ten_failures(gated_app):
    client = gated_app.test_client()
    for _ in range(10):
        assert _login(client, password="wrong").status_code == 401
    assert _login(client, password="wrong").status_code == 429
    # Correct password refused while blocked.
    assert _login(client, password=PASSWORD).status_code == 429


def test_session_cookie_flags(gated_app):
    resp = _login(gated_app.test_client())
    set_cookie = "\n".join(v for k, v in resp.headers if k.lower() == "set-cookie")
    assert "HttpOnly" in set_cookie
    assert "Secure" in set_cookie
    assert "SameSite=Lax" in set_cookie
    assert "battery" not in set_cookie  # raw password never in the cookie


def test_api_entries_gated_when_unauth(gated_app):
    resp = gated_app.test_client().get("/api/entries", base_url=HTTPS)
    assert resp.status_code == 302  # redirected to /login


def test_security_headers_present(gated_app):
    resp = gated_app.test_client().get("/login", base_url=HTTPS)
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert "default-src 'self'" in resp.headers["Content-Security-Policy"]
    assert "'unsafe-inline'" not in resp.headers["Content-Security-Policy"]


# -- /api/entries content ----------------------------------------------------

def test_api_entries_returns_snapshot(gated_app):
    client = gated_app.test_client()
    _login(client)
    resp = client.get("/api/entries", base_url=HTTPS)
    assert resp.status_code == 200
    assert resp.mimetype == "application/json"
    body = resp.get_json()
    assert body["baby"]["label"] == "The Baby Pool"
    assert [e["name"] for e in body["entries"]] == ["Abbey & Warren", "John Heller"]


def test_api_entries_missing_file_is_empty_pool_not_500(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", PASSWORD)
    monkeypatch.setenv("SESSION_SECRET", "unit-test-session-secret")
    _clear_gate_env(monkeypatch)
    # Point at an empty dir — no entries.json.
    app = create_app(data_dir=tmp_path / "empty")
    client = app.test_client()
    _login(client)
    resp = client.get("/api/entries", base_url=HTTPS)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["entries"] == []
    assert body["baby"]["label"] == "The Baby Pool"


def test_api_entries_unparseable_file_is_empty_pool_not_500(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", PASSWORD)
    monkeypatch.setenv("SESSION_SECRET", "unit-test-session-secret")
    _clear_gate_env(monkeypatch)
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    (data_dir / "entries.json").write_text("{ this is not json", encoding="utf-8")
    app = create_app(data_dir=data_dir)
    client = app.test_client()
    _login(client)
    resp = client.get("/api/entries", base_url=HTTPS)
    assert resp.status_code == 200
    assert resp.get_json()["entries"] == []


# -- gate off ----------------------------------------------------------------

def test_gate_off_when_password_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("APP_PASSWORD", raising=False)
    _clear_gate_env(monkeypatch)
    data_dir = tmp_path / "data"
    _write_snapshot(data_dir, SNAPSHOT)
    app = create_app(data_dir=data_dir)
    client = app.test_client()
    # No login required.
    assert client.get("/", base_url=HTTPS).status_code == 200
    assert client.get("/api/entries", base_url=HTTPS).status_code == 200


def test_gate_off_empty_password_treated_as_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "")
    _clear_gate_env(monkeypatch)
    data_dir = tmp_path / "data"
    _write_snapshot(data_dir, SNAPSHOT)
    app = create_app(data_dir=data_dir)
    assert app.test_client().get("/", base_url=HTTPS).status_code == 200
