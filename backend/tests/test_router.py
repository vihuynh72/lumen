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
    monkeypatch.setattr(store, "ROOT", "plans/")
    monkeypatch.setattr(router, "parse_with_bedrock", bedrock_blocked)
    monkeypatch.setattr(router, "rank", stand_in_rank)
    return s3


def call(method, path, body=None, key="k3y", session=None):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path, "queryStringParameters": {"session": session} if session else None,
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


def test_text_source_is_fallback_when_every_model_row_was_rejected(monkeypatch):
    from lumen.ai import text
    # write_plan_text returned, but every row is the code template (the model's rows failed validation)
    monkeypatch.setitem(sys.modules, "lumen.ai.text", SimpleNamespace(
        write_plan_text=text.template_plan_text, template_plan_text=text.template_plan_text))
    assert plan_v1()["ai_sources"] == {"text": "fallback"}


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


def test_ai_steps_turns_model_steps_off(monkeypatch):
    calls = []
    monkeypatch.setenv("AI_STEPS", "parse")
    monkeypatch.setitem(sys.modules, "lumen.ai.text", SimpleNamespace(
        write_plan_text=lambda *a: calls.append("text"), template_plan_text=lambda *a: calls.append("tmpl") or a[0]))
    monkeypatch.setitem(sys.modules, "lumen.ai.replan", SimpleNamespace(replan=lambda *a: calls.append("replan")))
    plan = plan_v1()
    body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take four more"})[1]
    assert "text" not in calls and "replan" not in calls
    assert plan["ai_sources"] == {"text": "fallback"} and body["plan"]["ai_sources"]["replan"] == "fallback"


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


def test_sessions_keep_their_own_plans():
    a, b = "abcd1234", "wxyz9876"
    for s in (a, b):
        call("POST", "/alert", {"notice_text": NOTICE}, session=s)
        call("POST", "/plan", {"event_id": "PSPS-DEMO-01"}, session=s)
    assert call("POST", "/reset", session=b) == (200, {"ok": True, "deleted": 3})
    assert call("GET", "/state", session=b)[1]["plan"] is None
    assert call("GET", "/state")[1]["plan"] is None  # the shared space never saw either session
    status, plan = call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": ["all"], "edits": []}, session=a)
    assert status == 200 and plan["version"] == 2
    assert call("GET", "/state", session="BAD!")[0] == 400


def test_reset_twice_in_a_row():
    plan_v1()
    assert call("POST", "/reset")[0] == 200
    assert call("POST", "/reset") == (200, {"ok": True, "deleted": 0})
    state = call("GET", "/state")[1]
    assert state["event"] is None and state["plan"] is None and state["affected"] is None


def edit_stored(pid, **fields):
    """Change one row of the latest stored plan in place (no new version)."""
    plan = store.latest_plan("PSPS-DEMO-01")
    next(r for r in plan["patients"] if r["patient_id"] == pid).update(fields)
    store.save_plan(plan)


def block_p005():
    """P005 is HBsAg positive; C04 has no isolation station."""
    edit_stored("P005", action="transfer", clinic_id="C04", slot={"date": "2026-10-28", "shift": 2}, status="approved")


def fake_model(monkeypatch, reply):
    """Stub bedrock.converse for the explain tool; reply(payload) gives the tool input or raises."""
    from lumen.ai import bedrock
    monkeypatch.setenv("BEDROCK_MODEL_FAST", "test-fast")
    seen = {}

    def converse(model_id, system, messages, tools=None, tool_choice=None):
        seen.update(model_id=model_id, tool_choice=tool_choice, payload=json.loads(messages[0]["content"][0]["text"]))
        return {"tool_uses": [{"id": "t", "name": "explain", "input": reply(seen["payload"])}]}
    monkeypatch.setattr(bedrock, "converse", converse)
    return seen


def key(issues):
    return [(i["patient_id"], i["facility_id"], i["severity"], i["code"]) for i in issues if not i.get("soft")]


def test_check_falls_back_to_templates_when_the_model_fails(monkeypatch, capsys):
    plan_v1()
    block_p005()
    fake_model(monkeypatch, bedrock_blocked)
    status, body = call("POST", "/check", {"event_id": "PSPS-DEMO-01"})
    assert status == 200 and not list(validator("check").iter_errors(body))
    assert body["explained_by"] == "template" and {i["source"] for i in body["issues"]} == {"template"}
    assert body["issues"][0]["code"] == "hbv_no_isolation" and body["counts"]["block"] >= 1
    assert '"step": "check", "fallback": true' in capsys.readouterr().out
    assert call("POST", "/check", {})[0] == 400


def test_check_uses_model_sentences_that_pass_and_never_clears_a_block(monkeypatch):
    plan_v1()
    block_p005()
    fake_model(monkeypatch, bedrock_blocked)
    template = call("POST", "/check", {"event_id": "PSPS-DEMO-01"})[1]
    langs = {p["id"]: p["language"] for p in json.loads((SEED / "patients.json").read_text())}
    spanish = next(r["patient_id"] for r in store.latest_plan("PSPS-DEMO-01")["patients"]
                   if r["action"] == "transfer" and r["patient_id"] != "P005" and langs[r["patient_id"]] == "es")

    def reply(payload):
        texts = {0: "This one is fine now.", 1: "", 2: " ".join(["word"] * 31)}
        return {"items": [{"index": i["index"], "text": texts.get(i["index"], f"Plain sentence {i['index']}.")} for i in payload["issues"]]
                + [{"index": 999, "text": "No such issue."}],
                "soft": [{"patient_id": spanish, "code": "language_unconfirmed"}, {"patient_id": "P007", "code": "heart_failure_long_gap"},
                         {"patient_id": "P007", "code": "made_up"}]}
    seen = fake_model(monkeypatch, reply)
    status, body = call("POST", "/check", {"event_id": "PSPS-DEMO-01"})
    assert status == 200 and not list(validator("check").iter_errors(body))
    assert seen["model_id"] == "test-fast" and seen["tool_choice"] == "explain"
    assert "Maria Delgado" not in json.dumps(seen["payload"])  # the model never sees names
    issues = body["issues"]
    assert key(issues) == key(template["issues"]) and body["counts"]["block"] == template["counts"]["block"]  # blocks stay
    assert issues[0] == {"patient_id": "P005", "facility_id": "C04", "severity": "block", "code": "hbv_no_isolation",
                         "text": "This one is fine now.", "source": "bedrock"}  # reworded, still a block
    assert body["explained_by"] == "bedrock"
    sent = seen["payload"]["issues"]  # blocks first, then one example per warning kind, at most 12
    assert 3 <= len(sent) <= 12 and sent[0]["code"] == "hbv_no_isolation"
    assert len({i["code"] for i in sent[1:]}) == len(sent) - 1
    reworded = [i for i in issues if i["source"] == "bedrock"]
    assert len(reworded) == len(sent) - 2  # the empty and the 31-word sentences are dropped; the rest keep template text
    assert all(i["text"] == "This one is fine now." or i["text"].startswith("Plain sentence") for i in reworded)
    assert [(i["patient_id"], i["code"], i["source"]) for i in issues if i.get("soft")] == [(spanish, "language_unconfirmed", "template")]
    assert body["counts"]["warning"] == template["counts"]["warning"] + 1


def approved_plan():
    plan_v1()
    call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": ["all"]})
    rows = store.latest_plan("PSPS-DEMO-01")["patients"]
    return {a: [r["patient_id"] for r in rows if r["action"] == a] for a in ("transfer", "hospital", "early_session")}


def test_packet_sends_approved_rows_and_skips_the_rest():
    draft = next(r["patient_id"] for r in plan_v1()["patients"] if r["action"] == "transfer")
    status, body = call("POST", "/packet", {"event_id": "PSPS-DEMO-01", "patient_ids": [draft]})
    assert status == 200 and body["sent"] == [] and body["skipped"][0]["reason"].startswith("status is draft")
    assert body["plan"]["version"] == 1  # nothing sent: no new version
    ids = approved_plan()
    block_p005()
    transfer, hospital, early = next(p for p in ids["transfer"] if p != "P005"), ids["hospital"][0], ids["early_session"][0]
    status, body = call("POST", "/packet", {"event_id": "PSPS-DEMO-01", "patient_ids": [transfer, hospital, early, "P005"]})
    assert status == 200 and not list(validator("plan").iter_errors(body["plan"]))
    assert body["sent"] == [transfer, hospital] and body["plan"]["version"] == 3
    assert [s["patient_id"] for s in body["skipped"]] == [early, "P005"]
    assert body["skipped"][1]["reason"].startswith("blocked: P005 is HBsAg positive")
    rows = {r["patient_id"]: r for r in body["plan"]["patients"]}
    clinic = next(c for c in store.load_seed()["clinics"] if c["id"] == rows[transfer]["clinic_id"])
    assert rows[transfer]["packet"] == {"status": "sent", "sent_at": body["plan"]["created_at"], "channel": "simulated fax",
                                        "to": f"{clinic['name']} {clinic['phone']}", "version": 2}
    assert "packet" not in rows[early] and "packet" not in rows["P005"]
    assert body["plan"]["audit"][-2]["change"] == f"{transfer} packet sent (simulated fax to {clinic['phone']})"
    again = call("POST", "/packet", {"event_id": "PSPS-DEMO-01", "patient_ids": [transfer]})[1]
    assert again["skipped"] == [{"patient_id": transfer, "reason": "packet already sent"}] and again["plan"]["version"] == 3
    assert call("POST", "/packet", {"event_id": "PSPS-DEMO-01", "patient_ids": ["P999"]})[0] == 404
    assert call("POST", "/packet", {"event_id": "PSPS-DEMO-01", "patient_ids": []})[0] == 400


def test_replan_marks_moved_sent_packets_stale_and_keeps_capacity_cuts(monkeypatch):
    monkeypatch.setattr(router, "replan_with_bedrock", bedrock_blocked)
    ids = approved_plan()
    call("POST", "/packet", {"event_id": "PSPS-DEMO-01", "patient_ids": ids["transfer"] + ids["hospital"]})
    before = {r["patient_id"]: r for r in store.latest_plan("PSPS-DEMO-01")["patients"]}
    status, body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take four more"})
    assert status == 200 and not list(validator("plan").iter_errors(body["plan"]))
    moved = {d["patient_id"] for d in body["diff"] if d["field"] in ("action", "clinic_id", "slot")}
    packets = {r["patient_id"]: r.get("packet") for r in body["plan"]["patients"]}
    assert moved & set(ids["transfer"]) and all(packets[p]["status"] == "stale" for p in moved if "packet" in before[p])
    assert all(packets[p] == before[p]["packet"] for p in before if "packet" in before[p] and p not in moved)
    assert packets[next(iter(moved & set(ids["transfer"])))]["sent_at"] == before[next(iter(moved & set(ids["transfer"])))]["packet"]["sent_at"]
    cuts = body["plan"]["capacity_overrides"]
    assert {c["clinic_id"] for c in cuts} == {"C02"} and sum(c["open_chairs"] for c in cuts) == 4
    assert call("POST", "/approve", {"event_id": "PSPS-DEMO-01", "patient_ids": ["all"]})[1]["capacity_overrides"] == cuts
    body = call("POST", "/replan", {"event_id": "PSPS-DEMO-01", "instruction": "DaVita Orangevale Dialysis Center can only take two more"})[1]
    assert {c["clinic_id"] for c in body["plan"]["capacity_overrides"]} == {"C02", "C04"}
    assert store.latest_plan("PSPS-DEMO-01")["capacity_overrides"] == body["plan"]["capacity_overrides"]
    fake_model(monkeypatch, bedrock_blocked)
    assert call("POST", "/check", {"event_id": "PSPS-DEMO-01"})[1]["counts"]["block"] == 0  # the second re-plan kept the C02 cut
