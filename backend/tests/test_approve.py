import copy
import json
from datetime import datetime
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from lumen.approve import UnknownPatient, apply, send_notes

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
PLAN1 = json.loads((CONTRACTS / "fixtures" / "plan.v1.json").read_text())
APPROVED = json.loads((CONTRACTS / "fixtures" / "approve.response.json").read_text())
SCHEMA = json.loads((CONTRACTS / "schemas" / "plan.schema.json").read_text())
NOW = datetime.fromisoformat("2026-10-26T09:05:00-07:00")
LANGS = {"P001": "es", "P002": "en", "P003": "zh", "P004": "en", "P005": "en"}


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


def notes(plan, ids=("all",), call_instead=(), blocks=(), now=NOW):
    return send_notes(plan, list(ids), list(call_instead), list(blocks), LANGS, now)


def test_send_notes_first_reason_wins():
    plan = copy.deepcopy(APPROVED)
    rows = {r["patient_id"]: r for r in plan["patients"]}
    rows["P002"]["status"] = "draft"  # draft and call_instead: not_approved comes first
    rows["P004"]["messages"] = {}
    rows["P005"]["status"] = "declined"  # declined and hospital: declined comes first
    block = {"patient_id": "P003", "facility_id": "C02", "severity": "block", "code": "hbv_no_isolation", "text": "x"}
    new, sent, queued, skipped = notes(plan, call_instead=["P002", "P001"], blocks=[block])
    assert new is None and sent == queued == []
    assert skipped == [{"patient_id": "P002", "reason": "not_approved"}, {"patient_id": "P001", "reason": "call_instead"},
                       {"patient_id": "P003", "reason": "blocked"}, {"patient_id": "P005", "reason": "declined"},
                       {"patient_id": "P004", "reason": "no_message"}]


def test_send_notes_one_note_per_patient_in_their_language():
    new, sent, queued, skipped = notes(APPROVED, ["P001", "P004", "P005", "P001"])
    assert sent == ["P001", "P004"] and queued == [] and skipped == [{"patient_id": "P005", "reason": "staff_call"}]
    assert new["version"] == 3 and new["audit"][-1] == {"ts": "2026-10-26T09:05:00-07:00", "actor": "Rosa",
                                                        "change": "voice notes sent to 2 patients (simulated)"}
    rows = {r["patient_id"]: r for r in new["patients"]}
    assert rows["P001"]["note"] == {"status": "sent", "sent_at": "2026-10-26T09:05:00-07:00", "send_at": None, "lang": "es",
                                    "channel": "simulated voice note", "version": 2}
    assert "note" not in rows["P005"] and "note" not in APPROVED["patients"][1]  # the input plan is not changed
    assert not list(Draft202012Validator(SCHEMA).iter_errors(new))
    assert notes(new, ["P001"])[3] == [{"patient_id": "P001", "reason": "already_sent"}]
    rows["P001"]["note"]["status"] = "stale"
    assert notes(new, ["P001"])[1] == ["P001"]  # a stale note can be sent again


def test_send_notes_without_the_patient_language_uses_english():
    plan = copy.deepcopy(APPROVED)
    next(r for r in plan["patients"] if r["patient_id"] == "P001")["messages"] = {"en": "Hi"}
    assert notes(plan, ["P001"])[0]["patients"][1]["note"]["lang"] == "en"


@pytest.mark.parametrize("now, send_at", [
    ("2026-10-26T20:00:00-07:00", "2026-10-27T08:00:00-07:00"),
    ("2026-10-27T07:59:00-07:00", "2026-10-27T08:00:00-07:00"),
    ("2026-10-27T03:30:00+00:00", "2026-10-27T08:00:00-07:00"),  # 20:30 local the day before
])
def test_send_notes_queue_in_quiet_hours(now, send_at):
    new, sent, queued, _ = notes(APPROVED, ["P001"], now=datetime.fromisoformat(now))
    assert sent == [] and queued == ["P001"]
    assert new["patients"][1]["note"] | {"version": 0} == {"status": "queued", "sent_at": None, "send_at": send_at, "lang": "es",
                                                        "channel": "simulated voice note", "version": 0}
    assert new["audit"][-1]["change"] == "voice notes queued for 08:00 for 1 patient (simulated)"
    assert notes(new, ["P001"])[3] == [{"patient_id": "P001", "reason": "already_sent"}]


@pytest.mark.parametrize("ids, call_instead, error", [
    ([], [], ValueError), ("all", [], ValueError), (["all", "P001"], [], ValueError), ([1], [], ValueError),
    (["P001"], ["P999"], ValueError), (["P001"], "P001", ValueError), (["P999"], [], UnknownPatient),
])
def test_send_notes_bad_request_raises(ids, call_instead, error):
    with pytest.raises(error):
        send_notes(APPROVED, ids, call_instead, [], LANGS, NOW)
