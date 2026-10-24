"""Every contract fixture and seed file validates, and the fixture plans obey the plan rules."""

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from lumen.affected import point_in_polygon

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "contracts" / "schemas"
FIXTURES = ROOT / "contracts" / "fixtures"
SEED = ROOT / "data" / "seed"

SHIFT_START = {1: (6, 0), 2: (10, 30), 3: (15, 0), 4: (19, 30)}

def load(path):
    return json.loads(path.read_text())


def validator(name):
    return Draft202012Validator(load(SCHEMAS / f"{name}.schema.json"))


def assert_valid(v, instance, label):
    errors = [f"{label} {'/'.join(map(str, e.absolute_path))}: {e.message}" for e in v.iter_errors(instance)]
    assert not errors, "\n".join(errors)


STATE = load(FIXTURES / "state.json")
RULES = STATE["rules"]
CLINICS = {c["id"]: c for c in STATE["clinics"]}
PATIENTS = {p["id"]: p for p in STATE["patients"]}
PLANS = {
    "plan.v1.json": load(FIXTURES / "plan.v1.json"),
    "plan.v2.json": load(FIXTURES / "plan.v2.json"),
    "replan.response.json plan": load(FIXTURES / "replan.response.json")["plan"],
    "approve.response.json": load(FIXTURES / "approve.response.json"),
    "packet.response.json plan": load(FIXTURES / "packet.response.json")["plan"],
    "notify.response.json plan": load(FIXTURES / "notify.response.json")["plan"],
    "state.json plan": STATE["plan"],
}


@pytest.mark.parametrize("path", sorted(SCHEMAS.glob("*.schema.json")), ids=lambda p: p.name)
def test_schema_is_valid(path):
    schema = load(path)
    Draft202012Validator.check_schema(schema)
    assert schema.get("version", 0) >= 1


def test_seed_files_validate():
    for c in load(SEED / "clinics.json"):
        assert_valid(validator("clinic"), c, f"clinics.json {c.get('id')}")
    for p in load(SEED / "patients.json"):
        assert_valid(validator("patient"), p, f"patients.json {p.get('id')}")
    assert_valid(validator("rules"), load(SEED / "rules.json"), "rules.json")


def test_state_fixture_validates():
    assert set(STATE) == {"version", "clinics", "patients", "outage_area", "rules", "event", "affected", "plan"}
    assert_valid(validator("affected"), STATE["affected"], "state affected")
    for c in STATE["clinics"]:
        assert_valid(validator("clinic"), c, f"state clinic {c['id']}")
    for p in STATE["patients"]:
        assert_valid(validator("patient"), p, f"state patient {p['id']}")
    assert_valid(validator("rules"), RULES, "state rules")
    assert_valid(validator("event"), STATE["event"], "state event")
    assert STATE["outage_area"]["features"][0]["geometry"]["type"] == "Polygon"


def test_event_fixture():
    event = load(FIXTURES / "event.json")
    assert_valid(validator("event"), event, "event.json")
    assert event["notice_type"] == "warning"
    assert event["start"] == "2026-10-27T18:00:00-07:00"
    assert event["end"] == "2026-10-29T12:00:00-07:00"
    assert event["area_name"] == STATE["outage_area"]["features"][0]["properties"]["event_area"]


def test_affected_fixture():
    affected = load(FIXTURES / "affected.json")
    assert_valid(validator("affected"), affected, "affected.json")
    assert affected["mode"] == "early" and affected["lead_hours"] == 33.0
    assert affected["now"] == "2026-10-26T09:00:00-07:00"
    ring = STATE["outage_area"]["features"][0]["geometry"]["coordinates"][0]
    assert affected["home_in_outage"] == {pid: point_in_polygon(p["home"]["lng"], p["home"]["lat"], ring) for pid, p in PATIENTS.items()}
    closed = [c["id"] for c in STATE["clinics"] if point_in_polygon(c["lng"], c["lat"], ring) and c["backup_power"] != "full"]
    assert affected["closed_clinic_ids"] == closed


@pytest.mark.parametrize("name", list(PLANS))
def test_plan_validates(name):
    assert_valid(validator("plan"), PLANS[name], name)


@pytest.mark.parametrize("name", list(PLANS))
def test_plan_rules(name):
    plan = PLANS[name]
    rows = plan["patients"]
    assert [r["rank"] for r in rows] == list(range(1, len(rows) + 1)), "rows must be in rank order 1..n"
    used = {}
    for r in rows:
        pid = r["patient_id"]
        assert pid in PATIENTS, f"{name}: unknown patient {pid}"
        assert r["urgency"] == sum(RULES["urgency"].get(k, 0) for k in r["reasons"]), f"{name} {pid}: urgency"
        assert r["difficulty"] == sum(RULES["difficulty"].get(k, 0) for k in r["reasons"]), f"{name} {pid}: difficulty"
        assert r["ride"] == PATIENTS[pid]["ride"]
        if r["clinic_id"] is not None:
            assert r["clinic_id"] in CLINICS, f"{name} {pid}: unknown clinic {r['clinic_id']}"
        if r["action"] in ("hospital", "notify_only"):
            assert r["messages"] == {}, f"{name} {pid}: no automated message without a confirmed chair"
        if r["reason_text"] is not None:
            assert len(r["reason_text"].split()) <= 20, f"{name} {pid}: reason_text over 20 words"
        if r["action"] == "hospital":
            assert CLINICS[r["clinic_id"]]["kind"] == "hospital" and r["slot"] is None
            assert pid in plan["overflow"] and "staff_call" in r["flags"]
        if r["action"] == "notify_only":
            assert r["affected_session"] is None and r["clinic_id"] is None and r["slot"] is None
        if r["slot"] is not None:
            key = (r["clinic_id"], r["slot"]["date"], r["slot"]["shift"])
            used[key] = used.get(key, 0) + 1
            h, m = SHIFT_START[r["slot"]["shift"]]
            start = datetime.fromisoformat(f"{r['slot']['date']}T{h:02d}:{m:02d}:00-07:00")
            expected = start - timedelta(minutes=r["drive_minutes"] + RULES["pickup_buffer_minutes"])
            assert datetime.fromisoformat(r["pickup_time"]) == expected, f"{name} {pid}: pickup_time"
            assert r["book_today"] == (r["ride"] == "paratransit")
        for lang, text in r["messages"].items():
            if lang != "zh":
                assert len(text.split()) < 40, f"{name} {pid} {lang}: message has 40 or more words"
    for (cid, date, shift), n in used.items():
        open_chairs = next((s["open_chairs"] for s in CLINICS[cid]["slots"] if (s["date"], s["shift"]) == (date, shift)), 0)
        assert n <= open_chairs, f"{name}: {cid} {date} shift {shift} given {n} times, {open_chairs} open"
    assert set(plan["overflow"]) <= set(PATIENTS)


def test_replan_response():
    resp = load(FIXTURES / "replan.response.json")
    assert_valid(validator("replan"), resp, "replan.response.json")
    assert resp["plan"] == PLANS["plan.v2.json"]
    v1 = {r["patient_id"]: r for r in PLANS["plan.v1.json"]["patients"]}
    v2 = {r["patient_id"]: r for r in resp["plan"]["patients"]}
    for d in resp["diff"]:
        assert v1[d["patient_id"]][d["field"]] == d["from"]
        assert v2[d["patient_id"]][d["field"]] == d["to"]


def test_approve_and_reset_responses():
    approved = PLANS["approve.response.json"]
    assert {r["status"] for r in approved["patients"]} == {"approved"}
    assert approved["audit"][-1]["change"] == "approved all"
    assert load(FIXTURES / "reset.response.json") == {"ok": True, "deleted": 4}


def test_check_response():
    body = load(FIXTURES / "check.response.json")
    assert_valid(validator("check"), body, "check.response.json")
    assert body["counts"] == {s: sum(i["severity"] == s for i in body["issues"]) for s in ("block", "warning")}
    assert body["explained_by"] == ("bedrock" if any(i["source"] == "bedrock" for i in body["issues"]) else "template")
    assert all(len(i["text"].split()) <= 30 for i in body["issues"] if i["source"] == "bedrock")


def test_packet_response():
    body = load(FIXTURES / "packet.response.json")
    rows = {r["patient_id"]: r for r in body["plan"]["patients"]}
    assert {p for p, r in rows.items() if "packet" in r} == set(body["sent"])
    assert all(rows[p]["action"] in ("transfer", "hospital") and rows[p]["status"] in ("approved", "confirmed") for p in body["sent"])
    assert [a["change"] for a in body["plan"]["audit"][-len(body["sent"]):]] == [
        f"{p} packet sent (simulated fax to {CLINICS[rows[p]['clinic_id']]['phone']})" for p in body["sent"]]
    assert body["skipped"] == [{"patient_id": "P001", "reason": "early_session rows get no packet"}]


def test_notify_response():
    body = load(FIXTURES / "notify.response.json")
    rows = {r["patient_id"]: r for r in body["plan"]["patients"]}
    assert {p for p, r in rows.items() if "note" in r} == set(body["sent"] + body["queued"])
    assert all(rows[p]["action"] in ("early_session", "transfer") and rows[p]["status"] in ("approved", "confirmed")
               and rows[p]["note"]["lang"] == PATIENTS[p]["language"] for p in body["sent"])
    assert {s["patient_id"] for s in body["skipped"]} | set(body["sent"]) == set(rows)  # ["all"]: one outcome per row
    assert body["plan"]["audit"][-1]["change"] == f"voice notes sent to {len(body['sent'])} patients (simulated)"
    assert body["plan"]["version"] == PLANS["approve.response.json"]["version"] + 1 and body["dry_run"] is False


def test_voice_response():
    assert load(FIXTURES / "voice.response.json") == {"url": "https://example.com/audio.mp3"}
