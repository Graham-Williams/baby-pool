"""Unit tests for scripts/build_entries.py — the Sheet -> entries.json parser.

Covers: 12-hour AM/PM + 24-hour time parsing, multiple date formats, blank-name
rows skipped, unparseable rows raise (fail loud), only Name/Date/Time survive
(payment columns never leak), and output is sorted by datetime.
"""

import build_entries as be
import pytest


def test_am_pm_time_conversion():
    rows = [{"Name": "John Heller", "Prediction Date": "8/20/2026",
             "Prediction TOD": "6:00:00 AM"}]
    out = be.build_entries(rows)
    assert out[0]["datetime"] == "2026-08-20T06:00:00"
    assert out[0]["time_label"] == "6:00 AM"
    assert out[0]["date_label"] == "Aug 20, 2026"


def test_pm_time_conversion():
    rows = [{"Name": "A", "Prediction Date": "8/17/2026",
             "Prediction TOD": "2:30 PM"}]
    out = be.build_entries(rows)
    assert out[0]["datetime"] == "2026-08-17T14:30:00"
    assert out[0]["time_label"] == "2:30 PM"


def test_midnight_and_noon_boundaries():
    rows = [
        {"Name": "Midnight", "Prediction Date": "8/21/2026", "Prediction TOD": "12:51 AM"},
        {"Name": "Noon", "Prediction Date": "8/20/2026", "Prediction TOD": "12:15 PM"},
    ]
    out = be.build_entries(rows)
    by = {e["name"]: e for e in out}
    assert by["Midnight"]["datetime"] == "2026-08-21T00:51:00"
    assert by["Noon"]["datetime"] == "2026-08-20T12:15:00"


def test_24_hour_time_supported():
    rows = [{"Name": "A", "Prediction Date": "2026-08-19", "Prediction TOD": "23:07"}]
    out = be.build_entries(rows)
    assert out[0]["datetime"] == "2026-08-19T23:07:00"


@pytest.mark.parametrize("date_raw,expected", [
    ("8/20/2026", "2026-08-20"),
    ("08/20/2026", "2026-08-20"),
    ("8/20/26", "2026-08-20"),
    ("2026-08-20", "2026-08-20"),
])
def test_multiple_date_formats(date_raw, expected):
    rows = [{"Name": "A", "Prediction Date": date_raw, "Prediction TOD": "1:00 PM"}]
    out = be.build_entries(rows)
    assert out[0]["datetime"].startswith(expected)


def test_blank_name_rows_skipped():
    rows = [
        {"Name": "", "Prediction Date": "8/20/2026", "Prediction TOD": "6:00 AM"},
        {"Name": "   ", "Prediction Date": "8/20/2026", "Prediction TOD": "6:00 AM"},
        {"Name": "Real", "Prediction Date": "8/20/2026", "Prediction TOD": "6:00 AM"},
    ]
    out = be.build_entries(rows)
    assert [e["name"] for e in out] == ["Real"]


def test_unparseable_date_raises():
    rows = [{"Name": "A", "Prediction Date": "someday", "Prediction TOD": "6:00 AM"}]
    with pytest.raises(ValueError):
        be.build_entries(rows)


def test_unparseable_time_raises():
    rows = [{"Name": "A", "Prediction Date": "8/20/2026", "Prediction TOD": "half past"}]
    with pytest.raises(ValueError):
        be.build_entries(rows)


def test_missing_date_or_time_raises():
    with pytest.raises(ValueError):
        be.build_entries([{"Name": "A", "Prediction Date": "", "Prediction TOD": "6:00 AM"}])
    with pytest.raises(ValueError):
        be.build_entries([{"Name": "A", "Prediction Date": "8/20/2026", "Prediction TOD": ""}])


def test_only_name_date_time_survive_payment_columns_stripped():
    # A row carrying payment/PII columns must never leak them into the output.
    rows = [{
        "Name": "A", "Prediction Date": "8/20/2026", "Prediction TOD": "6:00 AM",
        "Payment": "Venmo", "Payment Confirmed": "Yes", "Phone": "555-1234",
    }]
    out = be.build_entries(rows)
    assert set(out[0].keys()) == {"name", "datetime", "date_label", "time_label"}


def test_output_sorted_by_datetime():
    rows = [
        {"Name": "Late", "Prediction Date": "8/25/2026", "Prediction TOD": "8:00 AM"},
        {"Name": "Early", "Prediction Date": "8/13/2026", "Prediction TOD": "11:07 PM"},
        {"Name": "Mid", "Prediction Date": "8/19/2026", "Prediction TOD": "12:00 PM"},
    ]
    out = be.build_entries(rows)
    assert [e["name"] for e in out] == ["Early", "Mid", "Late"]


def test_name_with_ampersand_preserved():
    rows = [{"Name": "Abbey & Warren", "Prediction Date": "8/20/2026",
             "Prediction TOD": "6:00 AM"}]
    out = be.build_entries(rows)
    assert out[0]["name"] == "Abbey & Warren"


def test_header_aliases_tolerated():
    # The parser normalizes headers, so "Date"/"Time" aliases work too.
    rows = [{"name": "A", "date": "8/20/2026", "time": "6:00 AM"}]
    out = be.build_entries(rows)
    assert out[0]["datetime"] == "2026-08-20T06:00:00"
