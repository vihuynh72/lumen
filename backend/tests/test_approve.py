import copy
import json
from datetime import datetime
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from lumen.approve import apply

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
PLAN1 = json.loads((CONTRACTS / "fixtures" / "plan.v1.json").read_text())
APPROVED = json.loads((CONTRACTS / "fixtures" / "approve.response.json").read_text())
SCHEMA = json.loads((CONTRACTS / "schemas" / "plan.schema.json").read_text())
NOW = datetime.fromisoformat("2026-10-26T09:05:00-07:00")


def plan_with(**statuses):
    plan = copy.deepcopy(PLAN1)
    for r in plan["patients"]:
        r["status"] = statuses.get(r["patient_id"], r["status"])
    return plan


def statuses(plan):
    return {r["patient_id"]: r["status"] for r in plan["patients"]}


def changes(plan):
    return [a["change"] for a in plan["audit"]]


def test_approve_all_matches_fixture():
    before = copy.deepcopy(PLAN1)
    result = apply(PLAN1, ["all"], [], NOW)
    assert PLAN1 == before
    assert isinstance(result["timing_ms"]["total"], int)
    assert {**result, "timing_ms": None} == {**APPROVED, "timing_ms": None}
    assert not list(Draft202012Validator(SCHEMA).iter_errors(result))


def test_approve_all_skips_non_draft_and_a_repeat_logs_nothing():
    result = apply(plan_with(P001="declined"), ["all"], [], NOW)
    assert statuses(result)["P001"] == "declined"
    assert changes(result) == ["approved all"]
    again = apply(result, ["all"], [], NOW)
    assert again["version"] == 3 and again["audit"] == result["audit"]


def test_approve_list():
    result = apply(plan_with(P004="confirmed"), ["P003", "P004"], [], NOW)
    assert statuses(result) == {"P002": "draft", "P001": "draft", "P003": "approved", "P005": "draft", "P004": "confirmed"}
    assert changes(result) == ["approved P003"]


def test_pin_then_unpin_keeps_audit():
    pinned = apply(PLAN1, [], [{"patient_id": "P003", "pinned": True}], NOW)
    unpinned = apply(pinned, [], [{"patient_id": "P003", "pinned": False}], NOW)
    assert next(r for r in unpinned["patients"] if r["patient_id"] == "P003")["pinned"] is False
    assert changes(unpinned) == ["pinned P003", "unpinned P003"]
    assert unpinned["audit"][0] == {"ts": "2026-10-26T09:05:00-07:00", "actor": "Rosa", "change": "pinned P003"}


@pytest.mark.parametrize("status", ["confirmed", "declined", "no_answer"])
def test_status_edit_keeps_the_chair(status):
    result = apply(PLAN1, [], [{"patient_id": "P004", "status": status}], NOW)
    row = next(r for r in result["patients"] if r["patient_id"] == "P004")
    assert row["status"] == status and row["clinic_id"] == "C02" and row["slot"] is not None
    assert changes(result) == [f"P004 status {status}"]


def test_noop_edit_adds_no_audit():
    result = apply(PLAN1, [], [{"patient_id": "P003"}, {"patient_id": "P003", "pinned": False}], NOW)
    assert result["audit"] == [] and result["patients"] == PLAN1["patients"]


@pytest.mark.parametrize("patient_ids, edits", [
    ("all", []),
    ([], {"patient_id": "P003"}),
    (["P999"], []),
    ([["P003"]], []),
    (["all", "P003"], []),
    ([], [{"patient_id": "P999", "pinned": True}]),
    ([], ["P003"]),
    ([], [{"pinned": True}]),
    ([], [{"patient_id": "P003", "pinned": "yes"}]),
    ([], [{"patient_id": "P003", "status": "draft"}]),
])
def test_bad_request_raises(patient_ids, edits):
    with pytest.raises(ValueError):
        apply(PLAN1, patient_ids, edits, NOW)
