# CLAUDE.md — baby-pool

Guidance for Claude Code / Hopper working in this repo.

## What this is

A read-only, mobile-friendly web page for a **baby birth date/time guessing
pool**. Guests each guess when the baby will arrive; whoever's guess is
**closest** to the actual birth moment wins.

The pool label + parents shown on the page are supplied at sync time via
`build_entries.py --label/--parents`; the real (family-identifying) values live
ONLY in the gitignored `data/entries.json` snapshot on the box and the
operator's private notes — nothing family-identifying is committed to this
(public) repo.

Two tabs:
- **Data** — the raw entries (Name / Predicted Date / Predicted Time), sorted.
- **Insights** — a timeline of *who would win* as a function of the actual
  birth date/time. Because "closest guess wins", each guess owns a contiguous
  window on the timeline bounded by the midpoints to its neighbouring guesses
  (a 1-D Voronoi partition). Guests can **search their own name** to see the
  exact time range(s) in which they'd win. A person with multiple guesses owns
  the union of their guesses' windows.

Styled with fun, gentle "baby boy" animations (floating balloons, drifting
clouds, twinkling stars, confetti on search). Everything is computed
**client-side** from a single JSON snapshot; the server is a dumb static host
plus the password gate.

## Privacy / data model (IMPORTANT)

- The source of truth is a **private Google Sheet** (the entries sheet)
  that only Hopper can read. The sheet also has **payment columns**
  (Cash/Venmo, Payment Confirmed) — these are **deliberately never synced** and
  must never reach the page. `scripts/build_entries.py` only ever reads
  Name / Date / Time.
- **No pool data is committed to this (public) repo.** `data/entries.json` is
  gitignored and exists only on the box, synced in by Hopper. The repo is code
  only.
- The page is gated by the shared app password (see below), but treat it as
  user-facing: only Name/Date/Time are ever rendered.

## Data sync (Hopper-owned)

The box cannot read the Sheet (no Google creds there), so Hopper does the sync
from an environment that has Google Workspace access:

1. Read the Sheet's **`Raw` tab** (cols A–C: Name, Prediction Date, Prediction
   TOD) via the Google Workspace MCP — range `Raw!A:C`. The Raw tab is the
   sole source of truth (the sheet has other tabs; ignore them). Write the rows
   as a CSV.
2. `python scripts/build_entries.py rows.csv --label <label> --parents <a,b> --updated-at <ISO-UTC> > data/entries.json`
   — parses dates/times to ISO, strips everything but Name/Date/Time. The
   `--label`/`--parents` (family-identifying) values are passed at sync time,
   never committed.
3. `scp data/entries.json graham@<box>:~/baby-pool/data/entries.json`
   — the container bind-mounts `./data:/app/data:ro`, so the new snapshot is
   served immediately (no rebuild/restart needed).

A cron re-runs this periodically (entries trickle in until the birth). Retire
the cron once the baby has arrived and the winner is known.

## Architecture

- `babypool/web.py` — Flask app factory `create_app()`. Serves the single
  page + `/api/entries` (the JSON snapshot). Reuses the shared-password gate
  pattern from taste-twin (`babypool/password_gate.py`): `before_request`
  redirect to `/login`, constant-time compare, signed session cookie
  (itsdangerous via Flask session), per-IP failed-login rate limit, Host/Origin
  CSRF pin via `APP_HOST`, `/healthz` exempt.
- `babypool/templates/` — `base.html`, `index.html` (tabs), `login.html`.
- `babypool/static/` — `app.js` (tab switching, interval math, name search),
  `styles.css`, `animations` (CSS/JS for the baby-boy motifs).
- `scripts/build_entries.py` — the sync parser (see above). No network; pure
  transform, unit-testable.

The winner-interval math (`app.js`): sort entries by datetime; each guess i
owns `[ (t[i-1]+t[i])/2 , (t[i]+t[i+1])/2 )`; the first guess owns everything
before its right midpoint, the last owns everything after its left midpoint.
Exact-tie guesses (same datetime) are co-winners sharing one window.

## Run / test

Local dev (gate off unless APP_PASSWORD set):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# generate a local data snapshot first (needs the Sheet, so usually Hopper does it)
FLASK_APP=babypool.web flask run --port 8080
# or: gunicorn --bind 0.0.0.0:8080 "babypool.web:create_app()"
```

Tests: `pytest` (parser + interval-math + gate behaviour).

## Deploy

Self-hosted on the home box behind the shared Cloudflare tunnel, exactly like
taste-twin / todoist-points. Public at **baby-pool.graham-williams.com**,
gated by the shared `APP_PASSWORD` (no Cloudflare Access PIN). See `DEPLOY.md`.
Deploy from `main`: `cd ~/baby-pool && git pull && docker compose up -d --build`.

## Git workflow

- Feature branches: commit/push freely.
- `main` is **protected** — PR-only, only Graham merges. Never push to `main`,
  never commit secrets or pool data.
- Before pushing: the security gate (skeptical parallel review — secrets/PII,
  injection/auth/XSS, deps, data exposure) must be clean.

## Self-maintenance

Keep this file, `DEPLOY.md`, and `SETUP`/sync notes current when you change a
capability, dependency, or the deploy/sync flow — that's how the next session
picks up context.
