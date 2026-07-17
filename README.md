# baby-pool 🍼

A tiny, read-only, **mobile-first** web page for a baby birth date/time
**guessing pool**. Guests each guess *when* the baby will arrive; whoever's
guess is **closest** to the actual birth moment wins.

The pool title and parents shown on the page are supplied **at sync time** via
`build_entries.py --label/--parents` and live only in the gitignored snapshot on
the box (and the operator's private notes) — nothing family-identifying is
committed to this repo.

Everything is computed **client-side** from a single JSON snapshot. The Flask
server is just a static host plus a shared-password gate — no database, no
build step, no external JS/CSS/CDN.

## The two tabs

- **Data** — every guess (Name / Date / Time), sorted by predicted arrival.
- **Insights** — the fun part:
  - A **winner timeline**: since "closest guess wins", each guess owns a
    contiguous window of time bounded by the midpoints to its neighbouring
    guesses (a 1-D nearest-neighbour / Voronoi partition). The timeline shows
    who would win as a function of the real birth moment.
  - **Search your name** — type your name to see the exact time range(s) in
    which you'd win, in plain English (with a little confetti 🎉).
  - A **"widest coverage"** mini-leaderboard — who owns the most time.

Styled with gentle "baby boy" ambient motion (floating balloons, drifting
clouds, twinkling stars, confetti on a search match), all of which respects
`prefers-reduced-motion`.

## How the winner math works

Sort the guesses by predicted instant. Guess *i* owns the interval
`[ midpoint(t[i-1], t[i]) , midpoint(t[i], t[i+1]) )`. The **first** guess owns
everything *before* its right midpoint (open-ended "before"); the **last** owns
everything *after* its left midpoint (open-ended "after"). Guesses at the
**identical** instant are **co-winners** who share one window. A person with
multiple guesses owns the union of their guesses' windows. This is all in
`babypool/static/app.js` (`computeNodes`).

## Privacy / data model

- The source of truth is a **private Google Sheet** that only Hopper can read.
  That Sheet also has **payment columns** — these are **deliberately never
  synced** and never reach the page. `scripts/build_entries.py` only ever reads
  Name / Date / Time.
- **No pool data is committed to this repo.** `data/entries.json` is gitignored
  and lives only on the box, synced in by Hopper. The repo is code only.
- Names are rendered client-side via `textContent`/`createElement` **only**
  (never `innerHTML`), so a name containing `&`, `<`, or quotes can't inject
  markup. The strict CSP (`default-src 'self'`) is a second line of defense.

## Local development

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# You need a data/entries.json snapshot. Normally Hopper generates it from the
# Sheet; to make a throwaway local one from a CSV of Name,Date,Time rows:
python scripts/build_entries.py my_rows.csv --updated-at "$(date -u +%FT%TZ)" \
  --label "The Baby Pool" --parents "First,Second" > data/entries.json

# Run it (gate OFF because APP_PASSWORD is unset — local dev only):
BABYPOOL_DATA="$(pwd)/data" FLASK_APP=babypool.web flask run --port 8080
# or:
BABYPOOL_DATA="$(pwd)/data" gunicorn --bind 0.0.0.0:8080 "babypool.web:create_app()"
```

Then open http://localhost:8080. If `data/entries.json` is missing the page
still loads and shows an empty-pool state (the server never 500s on a missing
or malformed snapshot).

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Covers the Sheet→JSON parser (`build_entries`), the shared-password gate
(redirect / login / rate-limit / session flags), and `/api/entries` snapshot
serving including the missing-file empty-pool fallback.

## Configuration (env)

| Var              | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `APP_PASSWORD`   | Shared password. Unset/empty = gate **off** (local dev).       |
| `SESSION_SECRET` | Signs the session cookie. Set a stable random hex in prod.     |
| `APP_HOST`       | Public hostname; pins Host + Origin/Referer (CSRF defense).    |
| `BABYPOOL_DATA`  | Directory holding `entries.json` (default `/app/data`).        |

## Deploy

Self-hosted on the home box behind the shared Cloudflare tunnel, public at
**baby-pool.graham-williams.com**, gated by the shared `APP_PASSWORD`. See
[`DEPLOY.md`](DEPLOY.md) for the full runbook and the Sheet→box sync flow.
