import copy
import json
from pathlib import Path

import pytest

from fake_s3 import FakeS3
from lumen import store
from lumen.replan_tools import build_tools, diff_rows, replan_by_rules

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
    assert "1 patient move" in result["summary"]


def test_replan_by_rules_rejects_other_instructions():
    with pytest.raises(ValueError):
        replan_by_rules("Move P003 to Tuesday", PLAN1, tools(), SEEDS["clinics"])
    with pytest.raises(ValueError):
        replan_by_rules("Nowhere Clinic can only take two more", PLAN1, tools(), SEEDS["clinics"])


def test_diff_rows_flat_shape():
    new = copy.deepcopy(PLAN1["patients"])
    new[0]["status"] = "approved"
    assert diff_rows(PLAN1["patients"], new) == [{"patient_id": new[0]["patient_id"], "field": "status", "from": "draft", "to": "approved"}]
