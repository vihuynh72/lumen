import copy
import json
from pathlib import Path

from lumen.geo import estimate
from lumen.match import match

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
STATE = json.loads((FIXTURES / "state.json").read_text())
AFFECTED = json.loads((FIXTURES / "affected.json").read_text())
PLAN1 = json.loads((FIXTURES / "plan.v1.json").read_text())
RANKED = [{k: r[k] for k in ("patient_id", "rank", "urgency", "difficulty", "reasons")} for r in PLAN1["patients"]]


def clinics_with(slots_by_clinic=None, **clinic_changes):
    clinics = copy.deepcopy(STATE["clinics"])
    for c in clinics:
        if slots_by_clinic and c["id"] in slots_by_clinic:
            c["slots"] = slots_by_clinic[c["id"]]
        c.update(clinic_changes.get(c["id"], {}))
    return clinics


def run(clinics=None, locked=None, affected=None):
    clinics = clinics or STATE["clinics"]
    return match(RANKED, affected or AFFECTED, STATE["patients"], clinics, STATE["rules"],
                 estimate(STATE["patients"], clinics), locked)


def rows(result):
    return {r["patient_id"]: r for r in result["patients"]}


def slot(date, shift, chairs):
    return {"date": date, "shift": shift, "open_chairs": chairs}


def test_seed_v0_matches_fixture_without_text():
    expected = copy.deepcopy(PLAN1["patients"])
    for r in expected:
        r.update(reason_text=None, messages={})
    assert run() == {"patients": expected, "overflow": PLAN1["overflow"]}


def test_inputs_are_not_mutated():
    clinics = copy.deepcopy(STATE["clinics"])
    before = copy.deepcopy(clinics)
    run(clinics)
    assert clinics == before


def test_no_chair_given_twice():
    result = run(clinics_with({"C02": [slot("2026-10-29", 1, 1)]}))
    taken = [(r["clinic_id"], r["slot"]["date"], r["slot"]["shift"]) for r in result["patients"] if r["slot"]]
    assert len(taken) == len(set(taken))
    assert rows(result)["P004"]["action"] == "hospital"  # lower rank loses the single chair


def test_isolation_station_respected():
    wed = {"C02": [slot("2026-10-28", 2, 2)]}  # P003 (rank 3) takes one chair first: Wed is one day before its Thu session
    assert rows(run(clinics_with(wed, C02={"isolation_station": False})))["P005"]["action"] == "hospital"
    assert rows(run(clinics_with(wed)))["P005"]["action"] == "transfer"


def test_never_a_later_date():
    result = rows(run(clinics_with({"C02": [slot("2026-10-30", 1, 5)]})))
    assert result["P003"]["action"] == "hospital" and result["P004"]["action"] == "hospital"


def test_overflow_when_chairs_cut_to_zero():
    result = run(clinics_with({"C01": [], "C02": []}))
    assert {r["action"] for r in result["patients"]} == {"hospital"}
    assert sorted(result["overflow"]) == ["P001", "P002", "P003", "P004", "P005"]


def test_locked_row_unchanged_across_rerun():
    pinned = {**rows(run())["P004"], "pinned": True}
    result = rows(run(clinics_with({"C02": [slot("2026-10-29", 1, 1)]}), locked=[pinned]))
    assert result["P004"] == pinned
    assert result["P003"]["action"] == "hospital"  # the pinned row took the only chair first


def test_declined_row_gets_no_chair():
    declined = {**rows(run())["P003"], "status": "declined"}
    result = run(locked=[declined])
    p3 = rows(result)["P003"]
    assert p3["slot"] is None and p3["clinic_id"] is None and "staff_call" in p3["flags"]
    assert p3["action"] == "transfer" and "P003" in result["overflow"]
    assert rows(result)["P004"]["slot"] == {"date": "2026-10-29", "shift": 1}


def test_paratransit_pickup_not_before_service_start():
    # only a 6:00 AM early chair: P001 (paratransit) would need a 5:34 AM pickup
    result = rows(run(clinics_with({"C01": [slot("2026-10-27", 1, 2)], "C02": []})))
    assert result["P002"]["action"] == "early_session"
    assert result["P001"]["action"] == "hospital"


def test_tue_thu_sat_thursday_patient_gets_no_tuesday_early_session():
    result = rows(run(clinics_with({"C01": [slot("2026-10-27", 2, 9)]})))
    assert result["P003"]["action"] == "transfer" and result["P004"]["action"] == "transfer"


def test_critical_mode_order_and_staff_calls():
    critical = {**AFFECTED, "mode": "critical"}
    result = run(affected=critical)
    assert all("staff_call" in r["flags"] for r in result["patients"])
    assert all(r["action"] in ("transfer", "hospital") for r in result["patients"])


def test_unranked_unaffected_patient_becomes_notify_only():
    extra = {**STATE["patients"][0], "id": "P999"}
    clinics = STATE["clinics"]
    patients = STATE["patients"] + [extra]
    result = match(RANKED, AFFECTED, patients, clinics, STATE["rules"], estimate(patients, clinics))
    last = result["patients"][-1]
    assert last["patient_id"] == "P999" and last["action"] == "notify_only" and last["rank"] == 6


def at_now(iso, mode="early"):
    return {**AFFECTED, "now": iso, "mode": mode}


def test_no_pickup_in_the_past():
    result = run(affected=at_now("2026-10-27T05:20:00-07:00", "transfer"))
    assert rows(result)["P002"]["slot"] == {"date": "2026-10-27", "shift": 2}  # the 6:00 chair needs a 5:15 pickup
    assert all(r["pickup_time"] > "2026-10-27T05:20:00-07:00" for r in result["patients"] if r["pickup_time"])


def test_no_same_day_paratransit():
    p1 = rows(run(affected=at_now("2026-10-27T06:00:00-07:00", "transfer")))["P001"]
    assert p1["slot"] is None or p1["slot"]["date"] > "2026-10-27"


def test_locked_hospital_row_stays_in_overflow():
    pinned = {**rows(run())["P005"], "pinned": True}
    assert "P005" in run(locked=[pinned])["overflow"]


def test_declined_row_loses_its_message():
    declined = {**rows(run())["P003"], "status": "declined", "messages": {"en": "old move"}}
    assert rows(run(locked=[declined]))["P003"]["messages"] == {}


def test_bad_locks_raise_a_readable_error():
    p4 = rows(run())["P004"]
    for locked in ([{**p4, "pinned": True, "slot": {"date": "2026-10-28", "shift": 4}}],
                   [{**p4, "pinned": True}, {**rows(run())["P003"], "pinned": True}]):
        clinics = clinics_with({"C02": [slot("2026-10-29", 1, 1)]})
        try:
            run(clinics, locked=locked)
            assert False, "expected ValueError"
        except ValueError:
            pass


def test_affected_patient_missing_from_ranked_raises():
    try:
        match(RANKED[:-1], AFFECTED, STATE["patients"], STATE["clinics"], STATE["rules"], estimate(STATE["patients"], STATE["clinics"]))
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_critical_mode_tail_rows_get_staff_call():
    extra = {**STATE["patients"][0], "id": "P999"}
    patients = STATE["patients"] + [extra]
    result = match(RANKED, {**AFFECTED, "mode": "critical"}, patients, STATE["clinics"], STATE["rules"], estimate(patients, STATE["clinics"]))
    assert "staff_call" in result["patients"][-1]["flags"]
