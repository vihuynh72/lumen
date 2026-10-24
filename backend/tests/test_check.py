"""check_plan rules on the full seed (40 patients, 7 facilities)."""

import copy
import json
from pathlib import Path

from lumen.check import apply_overrides, check_plan, row_facts, soft_warnings
from lumen.geo import estimate

SEED_DIR = Path(__file__).resolve().parents[2] / "data" / "seed"
SEED = {name: json.loads((SEED_DIR / file).read_text()) for name, file in
        {"clinics": "clinics.json", "patients": "patients.json", "outage_area": "outage_area.geojson", "rules": "rules.json"}.items()}
LANG = {p["id"]: p["language"] for p in SEED["patients"]}


def row(pid, action, clinic_id, date=None, shift=None, status="approved", messages=None, affected=None):
    return {"patient_id": pid, "action": action, "clinic_id": clinic_id, "slot": {"date": date, "shift": shift} if date else None,
            "status": status, "messages": {LANG[pid]: "text"} if messages is None else messages, "affected_session": affected}


def check(*rows, seed=SEED, overrides=None):
    return check_plan({"created_at": "2026-10-26T09:00:00-07:00", "patients": list(rows)}, seed, overrides)


def codes(issues, severity=None):
    return sorted(((i["patient_id"], i["code"]) for i in issues if severity in (None, i["severity"])), key=str)


def test_hbsag_positive_needs_an_isolation_station():
    assert sorted(p["id"] for p in SEED["patients"] if p["hep_b_positive"]) == ["P005", "P026", "P039"]
    issues = check(row("P005", "transfer", "C04", "2026-10-28", 2), row("P026", "transfer", "C02", "2026-10-28", 2),
                   row("P039", "hospital", "H01"))
    assert codes(issues, "block") == [("P005", "hbv_no_isolation")]  # C02 and H01 have isolation stations
    assert issues[0]["text"] == "P005 is HBsAg positive, but DaVita Orangevale Dialysis Center has no isolation station."


def test_more_patients_than_open_chairs_blocks_the_slot():
    two = [row("P007", "transfer", "C02", "2026-10-28", 1), row("P010", "transfer", "C02", "2026-10-28", 1)]  # 2 open chairs
    assert codes(check(*two), "block") == []
    issues = check(*two, row("P013", "transfer", "C02", "2026-10-28", 1))
    assert [(i["patient_id"], i["facility_id"], i["code"], i["slot"]) for i in issues if i["severity"] == "block"] == [
        (None, "C02", "over_capacity", {"date": "2026-10-28", "shift": 1})]
    assert "has 2 open chairs on 2026-10-28 shift 1, but the plan sends 3 patients" in issues[0]["text"]


def test_capacity_overrides_count():
    two = [row("P007", "transfer", "C02", "2026-10-28", 1), row("P010", "transfer", "C02", "2026-10-28", 1)]
    cut = [{"clinic_id": "C02", "date": "2026-10-28", "shift": 1, "open_chairs": 1}]
    assert codes(check(*two, overrides=cut), "block") == [(None, "over_capacity")]
    before = copy.deepcopy(SEED["clinics"])
    assert apply_overrides(SEED["clinics"], cut)[1]["slots"][2]["open_chairs"] == 1 and SEED["clinics"] == before


def test_closed_or_no_visitors_blocks_clinics_only():
    issues = check(row("P002", "transfer", "C01", "2026-10-27", 1), row("P004", "transfer", "C03", "2026-10-28", 1),
                   row("P006", "hospital", "H01"), row("P009", "early_session", "C01", "2026-10-27", 1))
    assert codes(issues, "block") == [("P002", "clinic_closed"), ("P004", "no_visitors"), (None, "over_capacity")]
    assert all(i["facility_id"] == "C03" for i in issues if i["code"] == "over_capacity")  # C03 has no open slots
    assert issues[0]["severity"] == "block" and issues[-1]["severity"] == "warning"  # blocks come first


def test_late_shift_patient_at_a_clinic_with_no_late_shift():
    seed = copy.deepcopy(SEED)
    next(p for p in seed["patients"] if p["id"] == "P007")["shift"] = 4
    assert ("P007", "no_late_shift") in codes(check(row("P007", "transfer", "C02", "2026-10-28", 2), seed=seed))
    assert ("P007", "no_late_shift") not in codes(check(row("P007", "transfer", "C05", "2026-10-28", 4), seed=seed))


def test_no_hbv_test_date_warns_on_every_row_sent_away():
    issues = check(row("P007", "transfer", "C02", "2026-10-28", 2), row("P006", "hospital", "H01"),
                   row("P009", "early_session", "C01", "2026-10-27", 1))
    assert [i["patient_id"] for i in issues if i["code"] == "hbv_test_missing"] == ["P007", "P006"]
    assert all(i["severity"] == "warning" for i in issues)
    assert "Receiver tests on intake, result within 7 days" in issues[0]["text"].replace("receiver", "Receiver")


def test_paratransit_same_day_and_early_pickup():
    # P001 rides paratransit; the plan's demo clock is 2026-10-26
    assert ("P001", "same_day_paratransit") in codes(check(row("P001", "early_session", "C01", "2026-10-26", 2)))
    issues = check(row("P001", "early_session", "C01", "2026-10-27", 1))  # 6:00 session, pickup 5:34
    assert ("P001", "early_paratransit_pickup") in codes(issues) and ("P001", "same_day_paratransit") not in codes(issues)
    assert not {c for _, c in codes(check(row("P001", "early_session", "C01", "2026-10-27", 2)))} & {
        "same_day_paratransit", "early_paratransit_pickup"}


def test_drive_longer_than_the_cap():
    assert estimate(SEED["patients"], SEED["clinics"])["P013"]["C06"]["minutes"] > SEED["rules"]["drive_cap_minutes"]
    issues = check(row("P013", "transfer", "C06", "2026-10-28", 2))
    assert ("P013", "long_drive") in codes(issues)
    assert ("P001", "long_drive") not in codes(check(row("P001", "transfer", "C02", "2026-10-28", 2)))  # 28 minutes


def test_long_gap_after_is_recomputed():
    wed = "2026-10-28T06:00:00-07:00"  # P001 is Mon/Wed/Fri: the next usual session is Friday 2026-10-30
    assert ("P001", "long_gap_after") in codes(check(row("P001", "early_session", "C01", "2026-10-27", 2, affected=wed)))
    assert ("P001", "long_gap_after") not in codes(check(row("P001", "transfer", "C02", "2026-10-28", 2, affected=wed)))


def test_no_message_in_the_patient_language():
    assert ("P001", "no_message_in_language") in codes(check(row("P001", "transfer", "C02", "2026-10-28", 2, messages={"en": "x"})))
    assert ("P001", "no_message_in_language") not in codes(check(row("P001", "transfer", "C02", "2026-10-28", 2)))
    assert ("P006", "no_message_in_language") not in codes(check(row("P006", "hospital", "H01", messages={})))


def test_declined_and_notify_only_rows_are_not_checked():
    assert check(row("P005", "transfer", "C04", "2026-10-28", 2, status="declined"), row("P006", "notify_only", None)) == []


def test_soft_warnings_keep_only_true_facts():
    plan = {"created_at": "2026-10-26T09:00:00-07:00", "patients": [
        row("P001", "early_session", "C01", "2026-10-27", 2, affected="2026-10-28T06:00:00-07:00"),  # heart failure, long gap
        row("P007", "transfer", "C02", "2026-10-28", 2)]}
    facts = row_facts(plan, SEED)
    kept = soft_warnings([{"patient_id": "P001", "code": "heart_failure_long_gap"}, {"patient_id": "P001", "code": "heart_failure_long_gap"},
                          {"patient_id": "P007", "code": "heart_failure_long_gap"}, {"patient_id": "P007", "code": "made_up"},
                          {"patient_id": "P999", "code": "language_unconfirmed"}, {"patient_id": "P001", "code": "language_unconfirmed"}], facts)
    assert [(s["patient_id"], s["code"], s["severity"]) for s in kept] == [("P001", "heart_failure_long_gap", "warning")]
