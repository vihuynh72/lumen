import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

import lambda_function as router
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


def bedrock_blocked(text):
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


def test_rank_missing_gives_rank_step(monkeypatch):
    def not_landed(*args):
        raise ImportError("No module named 'lumen.ai.rank'")
    monkeypatch.setattr(router, "rank", not_landed)
    call("POST", "/alert", {"notice_text": NOTICE})
    status, body = call("POST", "/plan", {"event_id": "PSPS-DEMO-01"})
    assert status == 500 and body["step"] == "rank"


def test_reset(env):
    call("POST", "/alert", {"notice_text": NOTICE})
    call("POST", "/plan", {"event_id": "PSPS-DEMO-01"})
    status, body = call("POST", "/reset")
    assert status == 200 and body == {"ok": True, "deleted": 2}
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
