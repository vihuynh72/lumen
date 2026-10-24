import json
from pathlib import Path

import pytest

from lumen.notice import parse_fallback

ROOT = Path(__file__).resolve().parents[2]


def test_demo_notice_matches_fixture_event():
    text = (ROOT / "data" / "seed" / "notice.txt").read_text()
    assert parse_fallback(text) == json.loads((ROOT / "contracts" / "fixtures" / "event.json").read_text())


def test_short_notice():
    event = parse_fallback((ROOT / "data" / "seed" / "notice_short.txt").read_text())
    assert event["event_id"] == "PSPS-DEMO-02"
    assert event["issued_at"] == "2026-10-27T14:00:00-07:00"
    assert event["start"] == "2026-10-27T18:00:00-07:00"


def test_unknown_layout_raises():
    with pytest.raises(ValueError):
        parse_fallback("Power may go out tomorrow in your area.")
