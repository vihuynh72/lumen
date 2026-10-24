import json
from pathlib import Path

from lumen.geo import estimate
from lumen.rank_fallback import rank_by_rules

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
STATE = json.loads((FIXTURES / "state.json").read_text())
AFFECTED = json.loads((FIXTURES / "affected.json").read_text())
PLAN1 = json.loads((FIXTURES / "plan.v1.json").read_text())


def test_seed_v0_matches_the_fixture_ranks():
    ranked = rank_by_rules(AFFECTED, STATE["patients"], STATE["rules"], estimate(STATE["patients"], STATE["clinics"]))
    expected = [{k: r[k] for k in ("patient_id", "urgency", "difficulty", "reasons", "rank")} for r in PLAN1["patients"]]
    assert ranked == expected


def test_unaffected_patients_are_not_ranked():
    affected = {**AFFECTED, "sessions": [s for s in AFFECTED["sessions"] if s["patient_id"] != "P002"]}
    ranked = rank_by_rules(affected, STATE["patients"], STATE["rules"], estimate(STATE["patients"], STATE["clinics"]))
    assert "P002" not in {r["patient_id"] for r in ranked} and [r["rank"] for r in ranked] == [1, 2, 3, 4]
