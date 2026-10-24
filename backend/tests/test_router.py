import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from jsonschema import Draft202012Validator

import lambda_function as router

REAL_RANK = router.rank
from fake_s3 import FakeS3
from lumen import store

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "data" / "seed"
SCHEMAS = ROOT / "contracts" / "schemas"
NOTICE = (SEED / "notice.txt").read_text()


def stand_in_rank(affected, patients, rules, drive):
    """Rank in patient order: enough to drive the router until rank.py lands."""
    ids = [s["patient_id"] for s in affected["sessions"]]
    return [{"patient_id": pid, "rank": i, "urgency": 0, "difficulty": 0, "reasons": []} for i, pid in enumerate(ids, 1)]


def bedrock_blocked(*args):
    raise RuntimeError("AccessDeniedException: Model use case details have not been submitted")


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("BUCKET", "test-bucket")
    monkeypatch.setenv("DEMO_KEY", "k3y")
    s3 = FakeS3()
    for file in store.SEED_FILES.values():
        s3.put_object(Bucket="b", Key=f"seed/{file}", Body=(SEED / file).read_bytes())
    monkeypatch.setattr(store, "_client", s3)
    monkeypatch.setattr(router, "parse_with_bedrock", bedrock_blocked)
    monkeypatch.setattr(router, "rank", stand_in_rank)
    return s3


def call(method, path, body=None, key="k3y"):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path,
             "headers": {"X-Demo-Key": key} if key else {}, "body": json.dumps(body) if body is not None else None}
    resp = router.lambda_handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def validator(name):
    return Draft202012Validator(json.loads((SCHEMAS / f"{name}.schema.json").read_text()))


def test_auth_rejects_missing_and_wrong_key():
    assert call("GET", "/state", key=None) == (401, {"error": "bad demo key", "step": "auth"})
    assert call("GET", "/state", key="nope")[0] == 401


def test_unknown_route_and_bad_body():
    assert call("GET", "/nope")[0] == 404
    assert call("POST", "/alert", body=[1, 2])[1]["step"] == "alert"
    assert call("POST", "/alert", body={})[0] == 400


def test_state_before_alert():
    status, body = call("GET", "/state")
    assert status == 200 and list(body) == ["version", "clinics", "patients", "outage_area", "rules", "event", "affected", "plan"]
    assert body["event"] is None and body["plan"] is None and len(body["patients"]) == 40


def test_alert_falls_back_when_bedrock_fails():
    status, event = call("POST", "/alert", {"notice_text": NOTICE})
    assert status == 200 and event["parse_source"] == "fallback" and event["event_id"] == "PSPS-DEMO-01"
    assert not list(validator("event").iter_errors(event))
    assert store.load_event("PSPS-DEMO-01") == event


def test_alert_uses_bedrock_when_it_works(monkeypatch):
    fixture = json.loads((ROOT / "contracts" / "fixtures" / "event.json").read_text())
    monkeypatch.setattr(router, "parse_with_bedrock", lambda text: fixture)
    assert call("POST", "/alert", {"notice_text": NOTICE})[1]["parse_source"] == "bedrock"


def test_unparseable_notice_is_a_400():
    assert call("POST", "/alert", {"notice_text": "lights out soon"}) [0] == 400


def test_plan_end_to_end():
    call("POST", "/alert", {"notice_text": NOTICE})
    status, plan = call("POST", "/plan", {"event_id": "PSPS-DEMO-01"})
    assert status == 200, plan
    assert not list(validator("plan").iter_errors(plan))
    assert plan["mode"] == "early" and plan["lead_hours"] == 33.0 and plan["version"] == 1
    assert {"affected", "drive", "rank", "match", "total"} <= set(plan["timing_ms"])
    assert len(plan["patients"]) == 40  # every affected session has one row
    status, state = call("GET", "/state")
    assert state["plan"]["version"] == 1 and state["event"]["event_id"] == "PSPS-DEMO-01"
    assert not list(validator("affected").iter_errors(state["affected"]))


def test_plan_errors():
    assert call("POST", "/plan", {"event_id": "NOPE"}) == (404, {"error": "no event NOPE", "step": "plan"})
    assert call("POST", "/plan", {})[0] == 400


def test_rank_falls_back_to_rules_when_rank_py_is_missing(monkeypatch, capsys):
    monkeypatch.setattr(router, "rank", REAL_RANK)
    monkeypatch.setitem(sys.modules, "lumen.ai.rank", None)  # simulate lumen.ai.rank failing to import
    call("POST", "/alert", {"notice_text": NOTICE})
    status, plan = call("POST", "/plan", {"event_id": "PSPS-DEMO-01"})
    assert status == 200 and [r["rank"] for r in plan["patients"]][:3] == [1, 2, 3]
    assert plan["patients"][0]["urgency"] >= plan["patients"][-1]["urgency"]
    assert '"step": "rank", "fallback": true' in capsys.readouterr().out


def test_reset(env):
    call("POST", "/alert", {"notice_text": NOTICE})
    call("POST", "/plan", {"event_id": "PSPS-DEMO-01"})
    status, body = call("POST", "/reset")
    assert status == 200 and body == {"ok": True, "deleted": 3}  # event, clock, plan v1
    assert call("GET", "/state")[1]["event"] is None


def test_names_filled_only_in_responses(env):
    call("POST", "/alert", {"notice_text": NOTICE})
    call("POST", "/plan", {"event_id": "PSPS-DEMO-01"})
    stored = store.latest_plan("PSPS-DEMO-01")
    stored["patients"][0]["messages"] = {"en": "{name}, this is DaVita Cameron Park."}
    store.save_plan(stored)
    first = call("GET", "/state")[1]["plan"]["patients"][0]
    assert first["messages"]["en"].startswith("Maria Delgado") or not first["messages"]["en"].startswith("{name}")
    assert store.latest_plan("PSPS-DEMO-01")["patients"][0]["messages"]["en"].startswith("{name}")


def plan_v1():
    call("POST", "/alert", {"notice_text": NOTICE})
    return call("POST", "/plan", {"event_id": "PSPS-DEMO-01"})[1]


def test_plan_gets_template_messages_when_text_fails():
    plan = plan_v1()
    moves = [r for r in plan["patients"] if r["action"] in ("early_session", "transfer")]
    assert moves and all("{name}" not in m for r in moves for m in r["messages"].values())
    assert plan["summary"].count(".") == 2
    stored = store.latest_plan("PSPS-DEMO-01")  # names are filled only in responses; stored text keeps the placeholder
    assert all("{name}" in m for r in stored["patients"] if r["action"] in ("early_session", "transfer") for m in r["messages"].values())


def test_replan_falls_back_to_rules(monkeypatch):
    def blocked(*args):
        raise RuntimeError("ThrottlingException: Too many tokens per day")
    monkeypatch.setattr(router, "replan_with_bedrock", blocked)
    plan_v1()
    status, body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take one more"})
    assert status == 200, body
    assert body["plan"]["version"] == 2 and body["diff"] and body["summary"]
    assert not list(validator("replan").iter_errors(body)) and not list(validator("plan").iter_errors(body["plan"]))
    assert body["plan"]["audit"][-1]["change"].startswith("re-plan: DaVita Folsom")
    assert call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "do something"})[0] == 400


def test_approve_then_voice(monkeypatch):
    plan_v1()
    status, plan = call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": ["all"], "edits": []})
    assert status == 200 and plan["version"] == 2 and {r["status"] for r in plan["patients"]} == {"approved"}
    move = next(r for r in plan["patients"] if r["action"] == "transfer")
    pid = move["patient_id"]
    assert call("POST", "/voice", {"event_id": "PSPS-DEMO-01", "patient_id": pid, "lang": "en"})[0] == 409  # approved, not confirmed
    call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": [], "edits": [{"patient_id": pid, "status": "confirmed"}]})
    monkeypatch.setattr(router.voice, "make_voice", lambda e, p, lang, text: f"audio/{e}/{p}.{lang}.mp3")
    monkeypatch.setattr(router.voice, "presign", lambda key: f"https://example.com/{key}")
    status, body = call("POST", "/voice", {"event_id": "PSPS-DEMO-01", "patient_id": pid, "lang": "en"})
    assert status == 200 and body["url"].endswith(f"{pid}.en.mp3")
    row = next(r for r in store.latest_plan("PSPS-DEMO-01")["patients"] if r["patient_id"] == pid)
    assert row["audio"] == {"en": f"audio/PSPS-DEMO-01/{pid}.en.mp3"}
    assert call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": "all"})[0] == 400


def test_replan_after_a_decline_uses_template_text(monkeypatch):
    monkeypatch.setattr(router, "replan_with_bedrock", lambda *a: (_ for _ in ()).throw(RuntimeError("throttled")))
    plan = plan_v1()
    move = next(r for r in plan["patients"] if r["action"] == "transfer" and r["clinic_id"] != "C02")
    call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": [], "edits": [{"patient_id": move["patient_id"], "status": "declined"}]})
    status, body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take four more"})
    assert status == 200, body
    declined = next(r for r in body["plan"]["patients"] if r["patient_id"] == move["patient_id"])
    assert declined["slot"] is None and declined["messages"] == {} and move["patient_id"] in body["plan"]["overflow"]


def test_two_edits_on_the_same_version_conflict(monkeypatch):
    plan_v1()
    old = store.latest_plan("PSPS-DEMO-01")
    monkeypatch.setattr(store, "latest_plan", lambda event_id: old)  # both requests read v1
    assert call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": ["all"]})[0] == 200
    assert call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": ["all"]}) == (
        409, {"error": "the plan changed while you edited it; reload and try again", "step": "approve"})


def test_field_errors_are_4xx():
    plan_v1()
    assert call("POST", "/voice", {"event_id": "PSPS-DEMO-01", "patient_id": "P003"})[0] == 400
    assert call("POST", "/voice", {"event_id": "PSPS-DEMO-01", "patient_id": "P003", "lang": ["en"]})[0] == 400
    assert call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": ["P999"]})[0] == 404
    event = {"requestContext": {"http": {"method": "POST"}}, "rawPath": "/approve", "headers": {"x-demo-key": "k3y"},
             "body": "//79", "isBase64Encoded": True}
    assert router.lambda_handler(event, None)["statusCode"] == 400


def test_ai_sources_say_fallback_when_bedrock_fails(monkeypatch):
    monkeypatch.setitem(sys.modules, "lumen.ai.text", SimpleNamespace(write_plan_text=bedrock_blocked))
    monkeypatch.setattr(router, "replan_with_bedrock", bedrock_blocked)
    assert plan_v1()["ai_sources"] == {"text": "fallback"}  # rank is rules only, so it has no key
    body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take four more"})[1]
    assert body["plan"]["ai_sources"] == {"replan": "fallback", "text": "fallback"}
    assert call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": ["all"]})[1]["ai_sources"] == {}


def test_ai_sources_say_bedrock_when_it_works(monkeypatch):
    monkeypatch.setitem(sys.modules, "lumen.ai.text", SimpleNamespace(
        write_plan_text=lambda plan, clinics, languages, only_ids: {**plan, "summary": "Bedrock wrote this. It has two sentences."}))
    monkeypatch.setattr(router, "replan_with_bedrock",
                        lambda instruction, plan, tools, clinics: router.replan_by_rules(instruction, plan, tools, clinics))
    plan = plan_v1()
    assert plan["ai_sources"] == {"text": "bedrock"} and not list(validator("plan").iter_errors(plan))
    body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take four more"})[1]
    assert body["plan"]["ai_sources"] == {"replan": "bedrock", "text": "bedrock"}
    assert not list(validator("plan").iter_errors(body["plan"]))
    assert store.latest_plan("PSPS-DEMO-01")["ai_sources"] == {"replan": "bedrock", "text": "bedrock"}


def test_text_fallback_writes_each_patient_language(monkeypatch):
    from lumen.ai import text
    monkeypatch.setitem(sys.modules, "lumen.ai.text", SimpleNamespace(
        write_plan_text=bedrock_blocked, template_plan_text=text.template_plan_text))
    plan = plan_v1()
    langs = {p["id"]: p["language"] for p in json.loads((SEED / "patients.json").read_text())}
    moves = [r for r in plan["patients"] if r["action"] in ("early_session", "transfer")]
    assert plan["ai_sources"] == {"text": "fallback"} and not list(validator("plan").iter_errors(plan))
    assert moves and all(langs[r["patient_id"]] in r["messages"] for r in moves)
    assert any(langs[r["patient_id"]] != "en" for r in moves)


def test_text_fallback_ends_at_the_english_template(monkeypatch):
    monkeypatch.setitem(sys.modules, "lumen.ai.text", SimpleNamespace(
        write_plan_text=bedrock_blocked, template_plan_text=bedrock_blocked))
    plan = plan_v1()
    assert plan["ai_sources"] == {"text": "fallback"}
    assert {lang for r in plan["patients"] for lang in r["messages"]} == {"en"}


def test_replan_gets_the_seed_clinics(monkeypatch):
    seen = {}

    def replan(instruction, plan, tools, clinics=None):
        seen["clinics"] = clinics
        raise RuntimeError("stop here, so the router uses the rules")
    monkeypatch.setitem(sys.modules, "lumen.ai.replan", SimpleNamespace(replan=replan))
    plan_v1()
    status, body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take four more"})
    assert status == 200 and body["plan"]["ai_sources"]["replan"] == "fallback"
    assert [c["id"] for c in seen["clinics"]] == [c["id"] for c in store.load_seed()["clinics"]]


def test_plan_timing_total_covers_every_reported_step():
    t = plan_v1()["timing_ms"]
    assert "save" not in t and t["total"] >= sum(v for k, v in t.items() if k != "total")


def test_slow_bedrock_steps_fall_back_before_the_lambda_timeout(monkeypatch):
    import time as _time
    monkeypatch.setattr(router, "DEADLINES", {"parse": 0.05, "text": 0.05, "replan": 0.05})
    monkeypatch.setattr(router, "parse_with_bedrock", lambda text: _time.sleep(1))
    monkeypatch.setattr(router, "replan_with_bedrock", lambda *a: _time.sleep(1))
    start = _time.perf_counter()
    assert call("POST", "/alert", {"notice_text": NOTICE})[1]["parse_source"] == "fallback"
    assert call("POST", "/plan", {"event_id": "PSPS-DEMO-01"})[0] == 200
    status, body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take four more"})
    assert status == 200 and body["diff"] and _time.perf_counter() - start < 1


def test_oversized_input_is_a_400():
    assert call("POST", "/alert", {"notice_text": "x" * 20_001})[0] == 400
    plan_v1()
    assert call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "y" * 501})[0] == 400


def test_reset_twice_in_a_row():
    plan_v1()
    assert call("POST", "/reset")[0] == 200
    assert call("POST", "/reset") == (200, {"ok": True, "deleted": 0})
    state = call("GET", "/state")[1]
    assert state["event"] is None and state["plan"] is None and state["affected"] is None
