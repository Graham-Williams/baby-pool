#!/usr/bin/env python3
"""Build the gitignored ``data/entries.json`` snapshot the web app serves.

The source of truth is a private Google Sheet, which only Hopper (with Google
Workspace access) can read. This script does the *parsing* half of the sync: it
takes the raw Name / Date / Time rows (as a CSV on stdin or a file) and emits a
clean, payment-free ``entries.json``.

Deliberately DATA-ONLY of the three columns the page is allowed to see:
Name, Prediction Date, Prediction TOD. The Cash/Venmo + Payment-Confirmed
columns are never read here, so they can never leak onto the (shared-password
but still user-facing) page.

The pool ``--label`` and ``--parents`` are supplied at sync time (they are NOT
hardcoded in this tracked script — they identify a specific family and are kept
out of the public repo). The real values live only in the gitignored snapshot
on the box and in the operator's private notes; the tracked defaults here are
generic placeholders.

Usage (the sync flow, run by Hopper where the Sheet is reachable):

    # 1. Hopper reads the Sheet via the Google Workspace MCP and writes cols
    #    A-C (Name, Date, Time) as a CSV, e.g. /tmp/rows.csv:
    #        Name,Prediction Date,Prediction TOD
    #        Jane Doe,8/20/2026,6:00:00 AM
    #        ...
    # 2. python scripts/build_entries.py /tmp/rows.csv \
    #        --label "The Baby Pool" --parents "First,Second" > data/entries.json
    # 3. scp data/entries.json onto the box's mounted volume.

The output schema is stable and consumed entirely client-side:

    {
      "updated_at": "<ISO-8601 UTC, passed via --updated-at>",
      "baby": {"parents": ["First", "Second"], "label": "The Baby Pool"},
      "entries": [
        {"name": "Jane Doe",
         "datetime": "2026-08-20T06:00:00",   # naive local wall-clock
         "date_label": "Aug 20, 2026",
         "time_label": "6:00 AM"},
        ...
      ]
    }
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime

# Accepted date / time input formats coming out of the Sheet. Google's CSV
# export gives US m/d/Y dates and 12-hour times; we stay lenient.
_DATE_FORMATS = ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d")
_TIME_FORMATS = ("%I:%M:%S %p", "%I:%M %p", "%H:%M:%S", "%H:%M")


def _parse_date(raw: str) -> datetime:
    raw = raw.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    raise ValueError(f"unrecognized date: {raw!r}")


def _parse_time(raw: str) -> tuple[int, int, int]:
    raw = raw.strip()
    for fmt in _TIME_FORMATS:
        try:
            t = datetime.strptime(raw, fmt)
            return t.hour, t.minute, t.second
        except ValueError:
            continue
    raise ValueError(f"unrecognized time: {raw!r}")


def build_entries(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Turn raw Name/Date/Time dict-rows into clean entry records.

    Rows missing a name are skipped (blank trailing rows). A row with an
    unparseable date/time raises, so a malformed Sheet fails loud rather than
    silently dropping someone's guess.
    """
    entries: list[dict[str, str]] = []
    for row in rows:
        # Be tolerant of exact header text; match on a normalized key.
        norm = {(k or "").strip().lower(): (v or "").strip()
                for k, v in row.items()}
        name = (norm.get("name") or "").strip()
        date_raw = norm.get("prediction date") or norm.get("date") or ""
        time_raw = (norm.get("prediction tod") or norm.get("time")
                    or norm.get("tod") or "")
        if not name:
            continue
        if not date_raw or not time_raw:
            raise ValueError(f"row for {name!r} missing date or time")

        d = _parse_date(date_raw)
        hh, mm, ss = _parse_time(time_raw)
        dt = d.replace(hour=hh, minute=mm, second=ss)
        entries.append({
            "name": name,
            "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "date_label": dt.strftime("%b %-d, %Y"),
            "time_label": dt.strftime("%-I:%M %p"),
        })
    # Stable sort by predicted moment — nice for the raw Data tab and makes the
    # client's interval math input already ordered.
    entries.sort(key=lambda e: e["datetime"])
    return entries


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv_path", nargs="?", default="-",
                    help="CSV of Name,Date,Time rows (default: stdin).")
    ap.add_argument("--updated-at", default="",
                    help="ISO-8601 UTC timestamp to stamp into the snapshot. "
                         "Pass the real sync time; left blank if omitted.")
    ap.add_argument("--label", default="The Baby Pool",
                    help="Pool title shown on the page (e.g. the family's baby "
                         "label). Default is the generic 'The Baby Pool'.")
    ap.add_argument("--parents", default="",
                    help="Comma-separated parent names for the subtitle "
                         "(e.g. 'First,Second'). Default empty (no subtitle).")
    args = ap.parse_args()

    parents = [p.strip() for p in args.parents.split(",") if p.strip()]
    baby = {"parents": parents, "label": args.label}

    if args.csv_path == "-":
        reader = csv.DictReader(sys.stdin)
        rows = list(reader)
    else:
        with open(args.csv_path, newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))

    entries = build_entries(rows)
    snapshot = {
        "updated_at": args.updated_at,
        "baby": baby,
        "entries": entries,
    }
    json.dump(snapshot, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
