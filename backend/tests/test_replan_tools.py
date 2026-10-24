import copy
import json
from pathlib import Path

import pytest

from fake_s3 import FakeS3
from lumen import store
from lumen.replan_tools import apply_changes, build_tools, diff_rows, replan_by_rules

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
STATE = json.loads((FIXTURES / "state.json").read_text())
PLAN1 = json.loads((FIXTURES / "plan.v1.json").read_text())
PLAN2 = json.loads((FIXTURES / "plan.v2.json").read_text())
REPLAN = json.loads((FIXTURES / "replan.response.json").read_text())
SEEDS = {k: STATE[k] for k in ("clinics", "patients", "outage_area", "rules")}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("BUCKET", "b")
    monkeypatch.setattr(store, "_client", FakeS3())
    store.save_event(STATE["event"])


def tools():
    return build_tools("PSPS-DEMO-01", PLAN1, SEEDS)


def rows(result):
    return {r["patient_id"]: r for r in result["patients"]}


def test_rerun_without_changes_keeps_v1():
    t = tools()
    assert t["rerun_matching"]()["patients"] == PLAN1["patients"]
    assert t["diff_plans"]() == []


def test_capacity_cut_matches_the_v2_fixture():
    t = tools()
    t["set_clinic_capacity"]("C02", "2026-10-29", 1, 1)
    result = t["rerun_matching"]()
    decision = lambda r: (r["action"], r["clinic_id"], r["slot"])  # noqa: E731
    assert [decision(r) for r in result["patients"]] == [decision(r) for r in PLAN2["patients"]]
    assert result["overflow"] == PLAN2["overflow"]
    assert t["diff_plans"]() == REPLAN["diff"]
    assert rows(result)["P003"]["messages"] == rows(PLAN1)["P003"]["messages"]  # same chair keeps its text


def test_decline_drops_the_chair():
    t = tools()
    t["decline_patient"]("P003")
    p3 = rows(t["rerun_matching"]())["P003"]
    assert p3["status"] == "declined" and p3["slot"] is None and "staff_call" in p3["flags"]


def test_pin_keeps_the_chair_through_a_cut():
    t = tools()
    t["pin_patient"]("P004", "C02", "2026-10-29", 1)
    t["set_clinic_capacity"]("C02", "2026-10-29", 1, 1)
    result = rows(t["rerun_matching"]())
    assert result["P004"]["pinned"] and result["P004"]["clinic_id"] == "C02"
    assert result["P003"]["action"] == "hospital"


def test_pin_to_a_new_slot_recomputes_pickup():
    t = tools()
    out = t["pin_patient"]("P003", "C02", "2026-10-28", 1)
    assert out["slot"] == {"date": "2026-10-28", "shift": 1} and out["pinned"]


def test_bad_tool_arguments_raise():
    t = tools()
    for call in (lambda: t["set_clinic_capacity"]("C99", "2026-10-29", 1, 1),
                 lambda: t["set_clinic_capacity"]("H01", "2026-10-29", 1, 1),
                 lambda: t["set_clinic_capacity"]("C02", "2026-10-29", 7, 1),
                 lambda: t["set_clinic_capacity"]("C02", "2026-10-29", 1, -1),
                 lambda: t["decline_patient"]("P999")):
        with pytest.raises(ValueError):
            call()


def test_inputs_not_mutated():
    plan, seeds = copy.deepcopy(PLAN1), copy.deepcopy(SEEDS)
    t = build_tools("PSPS-DEMO-01", plan, seeds)
    t["set_clinic_capacity"]("C02", "2026-10-29", 1, 0)
    t["decline_patient"]("P001")
    t["rerun_matching"]()
    assert plan == PLAN1 and seeds == SEEDS


def test_replan_by_rules_matches_the_fixture():
    result = replan_by_rules("DaVita Folsom Dialysis can only take one more", PLAN1, tools(), SEEDS["clinics"])
    assert result["diff"] == REPLAN["diff"]
    assert result["plan"]["overflow"] == PLAN2["overflow"]
    assert "1 more patient needs a phone call" in result["summary"]
    assert result["understood"] == ["DaVita Folsom Dialysis takes at most 1 more patient."]


def test_replan_by_rules_rejects_other_instructions():
    with pytest.raises(ValueError):
        replan_by_rules("Move P003 to Tuesday", PLAN1, tools(), SEEDS["clinics"])
    with pytest.raises(ValueError):
        replan_by_rules("Nowhere Clinic can only take two more", PLAN1, tools(), SEEDS["clinics"])


def test_diff_rows_flat_shape():
    new = copy.deepcopy(PLAN1["patients"])
    new[0]["status"] = "approved"
    assert diff_rows(PLAN1["patients"], new) == [{"patient_id": new[0]["patient_id"], "field": "status", "from": "draft", "to": "approved"}]


def test_rules_keep_a_confirmed_lower_ranked_row():
    plan = copy.deepcopy(PLAN1)
    p4 = next(r for r in plan["patients"] if r["patient_id"] == "P004")
    p4["status"] = "confirmed"  # P004 ranks below P003 at the same C02 slot
    t = build_tools("PSPS-DEMO-01", plan, SEEDS)
    result = replan_by_rules("DaVita Folsom Dialysis can only take one more", plan, t, SEEDS["clinics"])
    by = rows(result["plan"])
    assert by["P004"]["clinic_id"] == "C02" and by["P003"]["action"] == "hospital"


def test_rules_reject_ambiguous_or_extra_text():
    for text in ("DaVita can only take one more",
                 "DaVita Folsom Dialysis can only take one more, and Orangevale none"):
        with pytest.raises(ValueError):
            replan_by_rules(text, PLAN1, tools(), SEEDS["clinics"])
    assert replan_by_rules("davita folsom dialysis can only take 1 more patient.", PLAN1, tools(), SEEDS["clinics"])["diff"]


def test_rules_summary_counts_and_grammar():
    summary = replan_by_rules("DaVita Folsom Dialysis can only take one more", PLAN1, tools(), SEEDS["clinics"])["summary"]
    # the patient who loses the chair goes to the call list, so no one "moves" and that part is left out
    assert summary == "DaVita Folsom Dialysis can take only 1 more, so 1 more patient needs a phone call."


def test_pin_needs_a_real_slot_and_capacity_respects_locks():
    t = tools()
    with pytest.raises(ValueError):
        t["pin_patient"]("P003", "C02", "2026-11-05", 1)
    with pytest.raises(ValueError):
        t["set_clinic_capacity"]("C02", "2026-10-29T06:00", 1, 1)
    with pytest.raises(ValueError):
        t["set_clinic_capacity"]("C02", "2026-10-29", 1, True)
    t["pin_patient"]("P004", "C02", "2026-10-29", 1)
    with pytest.raises(ValueError):
        t["set_clinic_capacity"]("C02", "2026-10-29", 1, 0)


def test_apply_changes_decline_and_pin_write_the_sentences_in_code():
    names = {p["id"]: p["name"] for p in SEEDS["patients"]}
    result = apply_changes([{"kind": "decline", "patient_id": "P003"},
                            {"kind": "pin", "patient_id": "P005", "clinic_id": "C02", "date": "2026-10-29", "shift": 1}],
                           PLAN1, tools(), SEEDS["clinics"], names)
    by = rows(result["plan"])
    assert by["P003"]["status"] == "declined" and result["plan"]["overflow"] == ["P003"]
    assert by["P005"]["pinned"] and by["P005"]["action"] == "transfer" and by["P005"]["slot"] == {"date": "2026-10-29", "shift": 1}
    assert result["understood"] == [f"{names['P003']} will not come and needs a phone call.",
                                    f"{names['P005']} goes to DaVita Folsom Dialysis, Thu Oct 29, 6:00 AM."]
    assert result["summary"] == "1 patient moves to another slot and 1 more patient needs a phone call."
    assert not any(n in result["summary"] for n in names.values())  # the summary is stored: no names


def test_rules_read_a_full_name_decline_with_or_without_accents():
    pid = PLAN1["patients"][0]["patient_id"]
    name = next(p["name"] for p in SEEDS["patients"] if p["id"] == pid)
    for text in (f"{name} declined", f"{name.upper()} can't come.", f"{name} will not come"):
        result = replan_by_rules(text, PLAN1, tools(), SEEDS["clinics"], SEEDS["patients"])
        assert result["understood"] == [f"{name} will not come and needs a phone call."]
        assert next(r for r in result["plan"]["patients"] if r["patient_id"] == pid)["status"] == "declined"
    with pytest.raises(ValueError):
        replan_by_rules("Nobody Here declined", PLAN1, tools(), SEEDS["clinics"], SEEDS["patients"])
