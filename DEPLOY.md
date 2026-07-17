# Deploying baby-pool

Runbook for the home server (same box and posture as `taste-twin` /
`todoist-points` / `km-tracker`). The app runs 24/7 in one Docker container,
joins the existing Cloudflare tunnel's network, and is public at
**https://baby-pool.graham-williams.com**, gated by the shared **app password**
(`APP_PASSWORD`). **No Cloudflare Access PIN** — the app password is the sole
gate (same cutover posture as the other three apps).

## What it serves

A single read-only page computed entirely client-side from
`data/entries.json`. The container never writes; the snapshot is synced in from
the box host side (see [Data sync](#data-sync-hopper-owned)). There is **no
database, no staging instance, and no in-app job/worker**.

## Layout on the box

- Repo checkout: `~/baby-pool` (deploy from `main` only).
- Secrets: `~/baby-pool/.env` (untracked; copy from `.env.example` and fill in
  — see below).
- Data: `~/baby-pool/data/entries.json`, **bind-mounted read-only** into the
  container at `/app/data` (`./data:/app/data:ro` in `docker-compose.yml`). The
  app reads it fresh per request, so a re-synced snapshot is served immediately
  with **no rebuild or restart**.

## Sign-in: shared-password gate

The app has a built-in sign-in gated by `APP_PASSWORD`. When set, every request
(except `/login`, `/logout`, static assets, and `/healthz`) is redirected to
`/login` until the visitor enters the one shared password; a correct password
grants a signed, HttpOnly+Secure+SameSite=Lax session cookie (~30-day lifetime),
so re-auth is rare. Wrong passwords are rate-limited per client IP (10 fails /
15 min → temporary 429). **Unset/empty `APP_PASSWORD` = gate OFF** (local dev
only — never expose it that way).

Box `.env` vars:

```
APP_PASSWORD=<the-one-shared-password-Graham-hands-out>   # SAME as the other apps
SESSION_SECRET=<random-32+-byte-hex>                      # signs the cookie; keep it stable
APP_HOST=baby-pool.graham-williams.com                    # Host + Origin/Referer CSRF pin
```

Generate `SESSION_SECRET` once with:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

**Keep `APP_HOST` set** — it enforces the Origin/Referer CSRF pin on
`POST /login` and rejects Host-header/rebinding tricks. `docker-compose.yml`
already sets `APP_HOST`; the two secrets come from the box `.env`.

## Deploy / update

```bash
cd ~/baby-pool
git pull                       # main only
docker compose up -d --build
```

Verify health after:

```bash
docker compose ps                                  # healthcheck hits /healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://baby-pool.graham-williams.com/healthz  # 200
```

A redeploy is cheap and safe — there's no in-progress-game concern like
km-tracker and no mid-flight job like taste-twin. The read-only data mount is
untouched by a rebuild.

## Data sync (Hopper-owned)

The box can't read the Google Sheet (no Google creds there), so Hopper does the
sync from an environment with Google Workspace access, then pushes just the
clean snapshot onto the box's mounted volume:

```bash
# 1. Read the private entries Sheet cols A–C (Name, Prediction Date,
#    Prediction TOD) via the Google Workspace MCP; write them as a CSV
#    (payment columns are NEVER read).
# 2. Build the payment-free snapshot. --label/--parents carry the family
#    identity and are supplied here at sync time (kept out of the repo); the
#    real values live only in this snapshot and the operator's private notes:
python scripts/build_entries.py rows.csv --updated-at "$(date -u +%FT%TZ)" \
  --label "<pool label>" --parents "<First,Second>" > data/entries.json
# 3. Copy it onto the box's read-only mount — served immediately, no restart:
scp data/entries.json graham@<box>:~/baby-pool/data/entries.json
```

A cron re-runs this periodically (entries trickle in until the birth). **Retire
the cron once the baby has arrived and the winner is known.**

> The payment / "Payment Confirmed" columns are stripped at step 2 by
> `build_entries.py` (it only ever reads Name/Date/Time) and can never reach the
> container — the page is user-facing even behind the password.

## First boot

Nothing special — the app starts even with **no** `data/entries.json` (renders
an empty-pool state; never 500s). Do the first Sheet sync any time after the
container is up.

## Checks & logs

```bash
docker compose ps                          # healthcheck status
docker compose logs -f baby-pool           # gunicorn access + gate mode line
docker exec baby-pool cat /app/data/entries.json | head   # what's being served
```

## Cloudflare side (managed by Hopper via API, not this repo)

One-time, before first deploy:

1. Proxied CNAME `baby-pool` → `<km-tracker-tunnel-id>.cfargotunnel.com`.
2. Tunnel ingress rule on the `km-tracker` tunnel (before the catch-all 404):
   `baby-pool.graham-williams.com` → `http://baby-pool:8080`.
3. **No Access application** — the app-level `APP_PASSWORD` is the only gate
   (matches the km / todoist-points / taste-twin cutover).

Remember the cert gotcha: **single-label subdomains only** (`baby-pool`, never
`baby.pool`) — the free Universal SSL cert covers only one label.

## Invariants

- **No host port mapping** — reachable only via the tunnel network; the
  shared password is the gate.
- **Read-only data mount** (`./data:/app/data:ro`) — the container never writes
  the snapshot; only the host-side sync does.
- **No pool data in the repo** — `data/*.json` is gitignored; it lives only on
  the box.
- **No off-box backup needed** — the snapshot is fully re-derivable from the
  Sheet at any time.
