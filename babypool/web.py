"""Flask application for baby-pool: a read-only, mobile-first page for a
birth-date/time guessing pool.

Everything the visitor sees is computed client-side from a single JSON
snapshot (``data/entries.json``), so the server is a dumb static host plus the
shared-password gate. Security posture (mirrors taste-twin / todoist-points):

- App-level shared-password gate when ``APP_PASSWORD`` is set: every request
  that isn't ``/login``, ``/logout``, a static asset or ``/healthz`` is
  redirected to ``/login`` until the visitor presents the one shared password.
  Success stores a signed session marker (``SESSION_SECRET``); the raw password
  is never stored or logged. Unset ``APP_PASSWORD`` = gate OFF (local dev).
- ``APP_HOST``, when set, pins the Host header (all requests) and the
  Origin/Referer header (POSTs) — a CSRF / DNS-rebinding defense for the only
  state-changing route, ``POST /login``.
- A strict ``Content-Security-Policy`` (``default-src 'self'``): ALL CSS and JS
  live in external static files, so no ``'unsafe-inline'`` is needed. The only
  relaxation is ``img-src 'self' data:`` for the inline emoji favicon.
- The snapshot holds only Name / Date / Time (payment columns are stripped at
  sync time by ``scripts/build_entries.py`` and never reach this app). Names are
  rendered client-side via ``textContent`` only — never ``innerHTML`` — so a
  name like ``Abbey & Warren`` or ``<script>`` can't inject markup.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

from flask import (Flask, Response, abort, jsonify, redirect, render_template,
                   request, session, url_for)

from .password_gate import LoginRateLimiter, client_ip, safe_next

log = logging.getLogger("babypool.web")

# Strict CSP. Because we keep 100% of CSS/JS in external static files (no inline
# <script>/<style>, no inline event handlers), we do NOT need 'unsafe-inline'
# anywhere — a meaningful XSS hardening over taste-twin, which allows inline
# styles. The sole exception is the emoji favicon delivered as a data: URI,
# which needs img-src to permit data:.
_CSP = ("default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'none'; "
        "object-src 'none'")

# What /api/entries returns when the snapshot is missing or unparseable: an
# empty pool the page renders as an "entries coming soon" state. Never a 500 —
# a fresh box (before the first Sheet sync) must still serve a working page.
_EMPTY_SNAPSHOT = {
    "updated_at": "",
    "baby": {"parents": [], "label": "The Baby Pool"},
    "entries": [],
}


def _load_snapshot(data_dir: Path) -> dict:
    """Read ``entries.json`` fresh from disk, returning the empty snapshot on
    any problem (missing file, bad JSON, wrong shape).

    Read per request on purpose: the file is a few KB and is re-synced onto the
    read-only bind mount out-of-band by Hopper, so reading fresh means a new
    snapshot is served immediately with no restart and no cache-invalidation
    logic to get wrong.
    """
    path = data_dir / "entries.json"
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        log.warning("entries.json unavailable (%s) — serving empty pool", exc)
        return dict(_EMPTY_SNAPSHOT)
    # Be defensive about shape: the client assumes a list of entries and a
    # baby label. If either is missing/wrong-typed, fall back rather than ship
    # something the front-end will choke on.
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        log.warning("entries.json has unexpected shape — serving empty pool")
        return dict(_EMPTY_SNAPSHOT)
    data.setdefault("updated_at", "")
    data.setdefault("baby", dict(_EMPTY_SNAPSHOT["baby"]))
    return data


def create_app(data_dir: str | Path | None = None) -> Flask:
    """Application factory.

    ``data_dir`` (or ``$BABYPOOL_DATA``, default ``/app/data``) is the directory
    holding ``entries.json``. It exists as a parameter so tests can point at a
    temp dir.
    """
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO,
                            format="%(asctime)s %(levelname)s %(message)s",
                            datefmt="%H:%M:%S")

    app = Flask(__name__)
    data_dir = Path(
        data_dir or os.environ.get("BABYPOOL_DATA", "/app/data")).resolve()

    app_host = os.environ.get("APP_HOST", "").strip().lower()
    if not app_host:
        log.warning("APP_HOST not set — Host/Origin pinning disabled "
                    "(local dev mode only).")

    # -- app-level shared-password gate (env-gated by APP_PASSWORD) -----------
    app_password = os.environ.get("APP_PASSWORD", "")
    password_gate_enabled = bool(app_password)
    # Sign the session cookie: prefer SESSION_SECRET, reuse SECRET_KEY if
    # present, else fall back to an ephemeral per-boot key (warned about below).
    # Never hardcode a secret.
    session_secret = (os.environ.get("SESSION_SECRET", "")
                      or os.environ.get("SECRET_KEY", ""))
    app.secret_key = session_secret or secrets.token_hex(32)
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    )
    login_limiter = LoginRateLimiter()
    if password_gate_enabled:
        if not session_secret:
            log.warning("APP_PASSWORD set but SESSION_SECRET/SECRET_KEY unset "
                        "— using an ephemeral signing key; sessions won't "
                        "survive a restart. Set SESSION_SECRET.")
        log.info("APP_PASSWORD set — shared-password gate ENABLED.")
    else:
        log.info("APP_PASSWORD unset — shared-password gate OFF "
                 "(page served without login; local dev only).")
    # Paths reachable without a session even when the gate is on.
    gate_exempt_paths = {"/login", "/logout", "/healthz"}

    # -- middleware -----------------------------------------------------------

    @app.before_request
    def _password_gate():  # runs first; redirects unauth users to /login
        if not password_gate_enabled:
            return None
        path = request.path
        if path in gate_exempt_paths:
            return None
        if (request.endpoint == "static"
                or path.startswith(app.static_url_path.rstrip("/") + "/")):
            return None
        if session.get("bp_authed") is True:
            return None
        nxt = path
        if request.query_string:
            nxt = f"{path}?{request.query_string.decode('latin-1')}"
        return redirect(url_for("login", next=nxt))

    @app.before_request
    def _host_origin_pin():
        if not app_host or request.path == "/healthz":
            return None
        if request.host.split(":", 1)[0].lower() != app_host:
            abort(403)
        if request.method == "POST":
            # CSRF defense: a state-changing POST must carry at least one
            # same-origin signal that matches app_host. Origin is the most
            # trustworthy — if present it alone must match. When Origin is
            # absent (some browsers omit it) fall back to a same-host Referer.
            # A POST carrying NEITHER cannot be proven same-origin → reject.
            origin = request.headers.get("Origin", "")
            referer = request.headers.get("Referer", "")
            if origin:
                if (urlsplit(origin).hostname or "").lower() != app_host:
                    abort(403)
            elif referer:
                if (urlsplit(referer).hostname or "").lower() != app_host:
                    abort(403)
            else:
                abort(403)
        return None

    @app.after_request
    def _security_headers(resp: Response) -> Response:
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        # "same-origin" (not "no-referrer") so the app's own same-origin form
        # POST still carries a real Origin/Referer for the CSRF pin, while
        # sending no referrer to any cross-origin link.
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("Content-Security-Policy", _CSP)
        return resp

    # -- routes ---------------------------------------------------------------

    @app.get("/healthz")
    def healthz():
        # Gate-exempt, no auth: the container healthcheck hits this.
        return "ok", 200, {"Content-Type": "text/plain; charset=utf-8"}

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/entries")
    def api_entries():
        # Behind the gate (the page fetches it with the session cookie). Always
        # 200 — a missing/broken snapshot yields the empty pool, never a 500.
        return jsonify(_load_snapshot(data_dir))

    @app.get("/login")
    def login():
        if not password_gate_enabled:
            return redirect(url_for("index"))
        if session.get("bp_authed") is True:
            return redirect(safe_next(request.args.get("next")))
        return render_template(
            "login.html", next=request.args.get("next", ""), error=None)

    @app.post("/login")
    def login_post():
        # Host/Origin CSRF pin already ran in before_request for this POST.
        if not password_gate_enabled:
            return redirect(url_for("index"))
        next_target = request.form.get("next", "")
        ip = client_ip()
        if login_limiter.is_blocked(ip):
            log.warning("login blocked (rate limit) for %s", ip)
            return render_template(
                "login.html", next=next_target,
                error="Too many failed attempts. Try again in a few minutes."
            ), 429
        supplied = request.form.get("password", "")
        if hmac.compare_digest(supplied, app_password):
            session.clear()
            session["bp_authed"] = True
            session.permanent = True
            login_limiter.reset(ip)
            return redirect(safe_next(next_target))
        login_limiter.record_failure(ip)
        log.warning("failed login attempt from %s", ip)  # never log the password
        return render_template(
            "login.html", next=next_target,
            error="Incorrect password."), 401

    @app.get("/logout")
    def logout():
        session.clear()
        if password_gate_enabled:
            return redirect(url_for("login"))
        return redirect(url_for("index"))

    return app
