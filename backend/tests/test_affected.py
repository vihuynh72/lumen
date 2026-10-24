import json
from datetime import datetime
from pathlib import Path

from lumen.affected import DEFAULT_MODES, find_affected, mode_for, point_in_polygon

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "data" / "seed"
FIXTURES = ROOT / "contracts" / "fixtures"
NOW = datetime.fromisoformat("2026-10-26T09:00:00-07:00")
EVENT = json.loads((FIXTURES / "event.json").read_text())
STATE = json.loads((FIXTURES / "state.json").read_text())


def run(patients=None, clinics=None):
    return find_affected(EVENT, clinics or STATE["clinics"], patients or STATE["patients"], STATE["outage_area"], NOW)


def test_seed_v0_matches_fixture():
    assert run() == json.loads((FIXTURES / "affected.json").read_text())


def test_point_on_edge():
    square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    assert point_in_polygon(0, 0.5, square)  # left edge: inside
    assert not point_in_polygon(1, 0.5, square)  # right edge: outside
    assert point_in_polygon(0.5, 0.5, square)
    assert not point_in_polygon(1.5, 0.5, square)


def patient(days, shift, hours):
    p = dict(STATE["patients"][0])
    return {**p, "id": "P900", "days": days, "shift": shift, "hours": hours}


def test_session_ending_at_window_start_is_not_affected():
    # Tue shift 3 for 3 hours ends 18:00, the exact window start
    assert run([patient(["Tue", "Thu", "Sat"], 3, 3)])["sessions"] == []


def test_thu_shift_2_overlapping_noon_is_affected():
    sessions = run([patient(["Tue", "Thu", "Sat"], 2, 4)])["sessions"]
    assert [s["start"] for s in sessions] == ["2026-10-29T10:30:00-07:00"]


def test_full_backup_power_keeps_the_home_clinic_open():
    clinics = [{**c, "backup_power": "full"} if c["home"] else c for c in STATE["clinics"]]
    result = run(clinics=clinics)
    assert result["closed_clinic_ids"] == [] and result["sessions"] == []


def test_mode_thresholds():
    assert mode_for(24.0, DEFAULT_MODES) == "early"
    assert mode_for(23.9, DEFAULT_MODES) == "transfer"
    assert mode_for(6.0, DEFAULT_MODES) == "transfer"
    assert mode_for(5.9, DEFAULT_MODES) == "critical"
    rules = json.loads((SEED / "rules.json").read_text())
    assert DEFAULT_MODES == rules["modes"]


def test_now_in_utc_gives_the_same_sessions():
    utc_now = datetime.fromisoformat("2026-10-26T16:00:00+00:00")  # the demo clock in UTC
    result = find_affected(EVENT, STATE["clinics"], STATE["patients"], STATE["outage_area"], utc_now)
    assert result["sessions"] == json.loads((FIXTURES / "affected.json").read_text())["sessions"]
