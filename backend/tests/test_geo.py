import json
from pathlib import Path

from lumen.geo import estimate, haversine_km

STATE = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "state.json").read_text())


def test_shape_and_source():
    drive = estimate(STATE["patients"], STATE["clinics"])
    assert set(drive) == {p["id"] for p in STATE["patients"]}
    for per_clinic in drive.values():
        assert set(per_clinic) == {c["id"] for c in STATE["clinics"]}
        assert all(v["source"] == "estimate" and isinstance(v["minutes"], int) for v in per_clinic.values())


def test_matches_fixture_plan_minutes():
    drive = estimate(STATE["patients"], STATE["clinics"])
    for row in STATE["plan"]["patients"]:
        if row["drive_minutes"] is not None:
            assert drive[row["patient_id"]][row["clinic_id"]]["minutes"] == row["drive_minutes"]


def test_haversine():
    assert haversine_km(38.0, -121.0, 38.0, -121.0) == 0
    assert round(haversine_km(38.0, -121.0, 39.0, -121.0)) == 111  # one degree of latitude
