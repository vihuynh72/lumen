import copy
import json
import random
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from lumen.ai.rank import _facts, rank_patients
from lumen.geo import estimate
from lumen.rank_fallback import rank_by_rules

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
SEED_RULES = json.loads((Path(__file__).resolve().parents[2] / "data" / "seed" / "rules.json").read_text())
STATE = json.loads((FIXTURES / "state.json").read_text())
AFFECTED = json.loads((FIXTURES / "affected.json").read_text())
PLAN1 = json.loads((FIXTURES / "plan.v1.json").read_text())
PATIENTS, RULES = STATE["patients"], STATE["rules"]
NOW = datetime.fromisoformat(AFFECTED["now"])
KEYS = ("patient_id", "rank", "urgency", "difficulty", "reasons")


def patient(pid, **over):
    base = {"id": pid, "ride": "self", "language": "en", "mobility": "walks", "lives_alone": False, "flags": []}
    return {**base, **over}


def affected(*sessions, home=(), closed=("C01",)):
    """sessions: (patient_id, hours after the demo clock the session starts)."""
    rows = [{"patient_id": pid, "clinic_id": "C01", "start": (NOW + timedelta(hours=h)).isoformat(),
             "end": (NOW + timedelta(hours=h + 4)).isoformat()} for pid, h in sessions]
    return {**AFFECTED, "sessions": rows, "closed_clinic_ids": list(closed),
            "home_in_outage": {pid: pid in home for pid, _ in sessions}}  # like find_affected: one entry per patient


def order(ranked):
    return [r["patient_id"] for r in ranked]


def test_golden_matches_plan_v1_fixture():
    ranked = rank_patients(AFFECTED, PATIENTS, RULES)
    assert ranked == [{k: r[k] for k in KEYS} for r in PLAN1["patients"]]


def test_points_and_reasons_for_each_fixture_patient():
    got = {r["patient_id"]: (r["urgency"], r["difficulty"]) for r in rank_patients(AFFECTED, PATIENTS, RULES)}
    assert got == {"P001": (55, 65), "P002": (60, 15), "P003": (50, 15), "P004": (40, 10), "P005": (40, 10)}


def test_every_reason_is_a_rules_key_and_weights_come_from_rules():
    keys = set(RULES["urgency"]) | set(RULES["difficulty"])
    ranked = rank_patients(AFFECTED, PATIENTS, RULES)
    assert all(set(r["reasons"]) <= keys for r in ranked)
    heavy = {**RULES, "urgency": {**RULES["urgency"], "session_in_window": 99}}
    assert {r["urgency"] for r in rank_patients(AFFECTED, PATIENTS, heavy)} >= {99 + 20}


def test_ranks_are_consecutive_from_one_and_inputs_untouched():
    before = copy.deepcopy((AFFECTED, PATIENTS, RULES))
    ranked = rank_patients(AFFECTED, PATIENTS, RULES)
    assert [r["rank"] for r in ranked] == list(range(1, len(ranked) + 1))
    assert (AFFECTED, PATIENTS, RULES) == before


def test_order_uses_urgency_before_difficulty():
    # A has more difficulty but less urgency than B: urgency wins
    pts = [patient("A", ride="paratransit", mobility="wheelchair", lives_alone=True), patient("B", flags=["heart_failure"])]
    assert order(rank_patients(affected(("A", 2), ("B", 2)), pts, RULES)) == ["B", "A"]


def test_tie_break_difficulty():
    pts = [patient("A"), patient("B", ride="family")]  # same urgency; B adds no_car
    assert order(rank_patients(affected(("A", 2), ("B", 2)), pts, RULES)) == ["B", "A"]


def test_tie_break_earlier_session():
    pts = [patient("A"), patient("B")]
    assert order(rank_patients(affected(("A", 20), ("B", 10)), pts, RULES)) == ["B", "A"]


def test_tie_break_longer_drive():
    pts = [patient("A"), patient("B")]
    aff = affected(("A", 10), ("B", 10), closed=("C01",))
    drive = {"A": {"C01": {"minutes": 1, "source": "estimate"}, "C02": {"minutes": 20, "source": "estimate"}},
             "B": {"C01": {"minutes": 1, "source": "estimate"}, "C02": {"minutes": 45, "source": "estimate"}}}
    assert order(rank_patients(aff, pts, RULES, drive)) == ["B", "A"]
    # the closed clinic's drive does not count: only clinics that stay open
    drive["A"]["C01"]["minutes"] = 999
    assert order(rank_patients(aff, pts, RULES, drive)) == ["B", "A"]


def test_drive_key_is_skipped_when_drive_is_none_or_incomplete():
    pts = [patient("B"), patient("A")]
    aff = affected(("A", 10), ("B", 10))
    assert order(rank_patients(aff, pts, RULES)) == ["A", "B"]  # falls to patient id
    assert order(rank_patients(aff, pts, RULES, {})) == ["A", "B"]
    only_closed = {"A": {"C01": {"minutes": 5, "source": "estimate"}}, "B": {}}
    assert order(rank_patients(aff, pts, RULES, only_closed)) == ["A", "B"]


def test_final_tie_break_is_patient_id():
    pts = [patient("P3"), patient("P1"), patient("P2")]
    assert order(rank_patients(affected(("P1", 5), ("P2", 5), ("P3", 5)), pts, RULES)) == ["P1", "P2", "P3"]


@pytest.mark.parametrize("hours, within", [(36, True), (35.99, True), (36.01, False)])
def test_36_hour_boundary(hours, within):
    row = rank_patients(affected(("A", hours)), [patient("A")], RULES)[0]
    assert ("session_within_36h" in row["reasons"]) is within
    assert row["urgency"] == 40 + (20 if within else 0)


def test_no_car_and_limited_english_follow_the_plan_definitions():
    for ride, expect in [("self", False), ("family", True), ("paratransit", True), ("medical_van", True), ("wheelchair_van", True)]:
        row = rank_patients(affected(("A", 50)), [patient("A", ride=ride)], RULES)[0]
        assert ("no_car" in row["reasons"]) is expect, ride
    for lang, expect in [("en", False), ("es", True), ("zh", True)]:
        row = rank_patients(affected(("A", 50)), [patient("A", language=lang)], RULES)[0]
        assert ("limited_english" in row["reasons"]) is expect, lang


def test_home_in_outage_comes_from_affected():
    pts = [patient("A"), patient("B")]
    ranked = {r["patient_id"]: r for r in rank_patients(affected(("A", 50), ("B", 50), home=("A",)), pts, RULES)}
    assert "home_in_outage" in ranked["A"]["reasons"] and "home_in_outage" not in ranked["B"]["reasons"]


def test_unaffected_and_unknown_patients_are_not_ranked():
    pts = [patient("A"), patient("B")]
    assert order(rank_patients(affected(("A", 5), ("GHOST", 5)), pts, RULES)) == ["A"]
    assert rank_patients(affected(), pts, RULES) == []


def test_patient_with_two_sessions_uses_the_earliest():
    pts = [patient("A"), patient("B")]
    # earliest-wins: A's 10 h session counts, so A outranks B (last-wins would score A on 80 h and put B first)
    ranked = rank_patients(affected(("A", 10), ("A", 80), ("B", 20)), pts, RULES)
    assert order(ranked) == ["A", "B"] and "session_within_36h" in ranked[0]["reasons"]


def tied_world():
    pts = [patient(f"P{i:03d}", ride="family" if i % 2 else "self") for i in range(1, 13)]
    return affected(*[(p["id"], 10 if i < 6 else 12) for i, p in enumerate(pts)]), pts


@pytest.mark.parametrize("world", ["fixture", "tied"])
def test_same_input_same_order_across_50_shuffles(world):
    aff, pts = (AFFECTED, PATIENTS) if world == "fixture" else tied_world()
    expected = rank_patients(aff, pts, RULES)
    rng = random.Random(176)
    for _ in range(50):
        shuffled_pts, sessions = rng.sample(pts, len(pts)), rng.sample(aff["sessions"], len(aff["sessions"]))
        assert rank_patients({**aff, "sessions": sessions}, shuffled_pts, RULES) == expected


def test_router_calls_rank_patients_without_the_fallback(capsys):
    import lambda_function as router
    assert router.rank(AFFECTED, PATIENTS, RULES, None) == rank_patients(AFFECTED, PATIENTS, RULES)
    assert "fallback" not in capsys.readouterr().out


def test_every_rules_json_key_has_a_predicate():
    keys = set(SEED_RULES["urgency"]) | set(SEED_RULES["difficulty"])
    assert keys <= set(_facts(patient("A"), False, False))
    assert keys <= set(RULES["urgency"]) | set(RULES["difficulty"])  # the fixture's rules carry the same keys


def test_missing_flags_or_home_in_outage_raises():
    no_flags = {k: v for k, v in patient("A").items() if k != "flags"}
    with pytest.raises(KeyError):
        rank_patients(affected(("A", 5)), [no_flags], RULES)
    with pytest.raises(KeyError):
        rank_patients({k: v for k, v in affected(("A", 5)).items() if k != "home_in_outage"}, [patient("A")], RULES)
    with pytest.raises(KeyError):
        rank_patients({**affected(("A", 5)), "home_in_outage": {}}, [patient("A")], RULES)


def parity_world():
    """40 single-session patients with varied attributes and distinct session times."""
    rng = random.Random(7)
    pts = [patient(f"P{i:03d}", ride=rng.choice(["self", "family", "paratransit", "medical_van", "wheelchair_van"]),
                   language=rng.choice(["en", "es", "zh"]), mobility=rng.choice(["walks", "walker", "wheelchair"]),
                   lives_alone=rng.random() < 0.4, flags=rng.sample(["heart_failure", "missed_recently"], rng.randint(0, 2)),
                   home={"lat": 38.7 + rng.random() / 5, "lng": -120.9 + rng.random() / 5}) for i in range(1, 41)]
    hours = rng.sample(range(1, 400), len(pts))
    return affected(*[(p["id"], h / 4) for p, h in zip(pts, hours)], home=[p["id"] for p in pts if rng.random() < 0.3]), pts


def test_matches_the_rule_fallback_on_single_session_sets():
    clinics = [{"id": "C01", "lat": 38.73, "lng": -120.8}, {"id": "C02", "lat": 38.9, "lng": -120.6},
               {"id": "C03", "lat": 38.6, "lng": -121.0}]
    for aff, pts in [(AFFECTED, PATIENTS), parity_world()]:
        drive = estimate(pts, STATE["clinics"] if pts is PATIENTS else clinics)
        assert rank_patients(aff, pts, RULES, drive) == rank_by_rules(aff, pts, RULES, drive)
