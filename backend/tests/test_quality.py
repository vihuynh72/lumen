"""Offline checks for the quality-run tool: a fake HTTP layer, no network."""

from copy import deepcopy
import json
from pathlib import Path
import urllib.error

import pytest

from lumen.ai import quality

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "contracts" / "fixtures"
STATE = json.loads((FIXTURES / "state.json").read_text())
PLAN = json.loads((FIXTURES / "plan.v1.json").read_text())
PEOPLE = {p["id"]: p for p in STATE["patients"]}
CLINICS = {c["id"]: c for c in STATE["clinics"]}
KNOWN = set(PEOPLE) | set(CLINICS)
TEMPLATES = {
    "en": "{name}, your treatment is scheduled. A ride picks you up at 6:00 AM.",
    "es": "{name}, su tratamiento está programado. Salga de casa a las 6:00 por favor.",
    "zh": "{name}，请于6:00出发前往DaVita Folsom Dialysis。",
}


def with_names(plan):
    """What the router returns: placeholders filled with the patient's name."""
    out = deepcopy(plan)
    for row in out["patients"]:
        row["messages"] = {k: v.replace("{name}", PEOPLE[row["patient_id"]]["name"]) for k, v in row["messages"].items()}
    return out


def clean_plan(version=1, sources=None):
    plan = deepcopy(PLAN)
    plan["version"], plan["ai_sources"] = version, sources or {"text": "bedrock"}
    for row in plan["patients"]:
        lang = PEOPLE[row["patient_id"]]["language"]
        moving = row["action"] in ("early_session", "transfer")
        row["messages"] = {k: TEMPLATES[k] for k in dict.fromkeys(["en", lang])} if moving else {}
    return with_names(plan)


def a_moving_row(plan, lang=None):
    return next(r for r in plan["patients"] if r["messages"] and (lang is None or lang in r["messages"]))


def set_message(plan, lang, text):
    a_moving_row(plan, lang)["messages"][lang] = text


# invented IDs

def test_ids_clean():
    plan = clean_plan()
    assert quality.check_ids(plan, [], KNOWN) == 0


@pytest.mark.parametrize("mutate", [
    lambda p: p["patients"][0].__setitem__("patient_id", "P999"),
    lambda p: p["patients"][0].__setitem__("clinic_id", "C99"),
    lambda p: p["overflow"].append("P998"),
], ids=["patient", "clinic", "overflow"])
def test_ids_invented_in_plan(mutate):
    plan = clean_plan()
    mutate(plan)
    assert quality.check_ids(plan, [], KNOWN) == 1


def test_ids_invented_in_diff():
    diff = [{"patient_id": "P777", "field": "action", "from": "transfer", "to": "hospital"},
            {"patient_id": "P001", "field": "clinic_id", "from": "C02", "to": "C88"},
            {"patient_id": "P001", "field": "clinic_id", "from": "C99", "to": "H01"}]
    assert quality.check_ids(clean_plan(), diff, KNOWN) == 3


# schema

def test_schema_clean_and_broken():
    plan = clean_plan()
    assert quality.check_schema(plan) == 0
    del plan["summary"]
    assert quality.check_schema(plan) >= 1


# messages

def test_messages_clean():
    assert quality.check_messages(clean_plan(), STATE) == 0


def test_messages_word_limit_ignores_the_name():
    plan = clean_plan()
    row = a_moving_row(plan, "en")
    name = PEOPLE[row["patient_id"]]["name"]
    row["messages"]["en"] = name + ", " + " ".join(["word"] * 39)
    assert quality.check_messages(plan, STATE) == 0
    row["messages"]["en"] = name + ", " + " ".join(["word"] * 41)
    assert quality.check_messages(plan, STATE) == 1


def test_messages_zh_character_limit():
    plan = clean_plan()
    set_message(plan, "zh", "请" * 81)
    assert quality.check_messages(plan, STATE) == 1


def test_messages_leftover_placeholder():
    plan = clean_plan()
    set_message(plan, "en", "{name}, your treatment is scheduled.")
    assert quality.check_messages(plan, STATE) == 1


@pytest.mark.parametrize("lang,text", [
    ("en", "Your treatment has a risk today."), ("en", "Danger: your treatment moved."),
    ("en", "Your treatment, death is not planned."),
    ("es", "Su tratamiento tiene un riesgo por favor."), ("es", "Su tratamiento, peligro en casa por favor."),
    ("es", "Su tratamiento y la muerte por favor."),
    ("zh", "请于6:00出发，有危险。"), ("zh", "请于6:00出发，有风险。"), ("zh", "请于6:00出发，致命。"),
])
def test_messages_banned_words(lang, text):
    plan = clean_plan()
    set_message(plan, lang, text)
    assert quality.check_messages(plan, STATE) == 1


@pytest.mark.parametrize("lang,text", [
    ("en", "Su tratamiento está programado, salga de casa por favor 请出发。"),
    ("es", "Your treatment is scheduled and a ride picks you up at six."),
    ("es", "Su tratamiento está programado，请于6:00出发。"),
    ("zh", "Your treatment is scheduled and a ride picks you up at six."),
    ("zh", "请出发. Your treatment is scheduled for tomorrow morning."),
], ids=["en-with-cjk", "es-in-english", "es-with-cjk", "zh-in-english", "zh-with-latin-sentence"])
def test_messages_wrong_language(lang, text):
    plan = clean_plan()
    set_message(plan, lang, text)
    assert quality.check_messages(plan, STATE) >= 1


def test_messages_zh_may_hold_a_clinic_name():
    plan = clean_plan()
    clinic = CLINICS["C02"]["name"]
    set_message(plan, "zh", f"请于6:00出发前往{clinic}，{CLINICS['C02']['address']}。")
    assert quality.check_messages(plan, STATE) == 0


# row coverage

def test_coverage_clean():
    assert quality.check_coverage(clean_plan(), STATE) == 0


def test_coverage_missing_languages_and_stray_rows():
    plan = clean_plan()
    row = a_moving_row(plan, "es")
    del row["messages"]["es"]
    assert quality.check_coverage(plan, STATE) == 1
    row["messages"] = {}
    assert quality.check_coverage(plan, STATE) == 1
    other = a_moving_row(plan, "en")
    other["messages"].pop("en")
    assert quality.check_coverage(plan, STATE) == 2


def test_coverage_ignores_rows_that_do_not_move():
    plan = clean_plan()
    stay = next(r for r in plan["patients"] if r["action"] not in ("early_session", "transfer"))
    stay["messages"] = {}
    assert quality.check_coverage(plan, STATE) == 0


# the run loop with a fake HTTP layer

class Server:
    def __init__(self, replan_sources=None, parse_source="bedrock", text_source="bedrock", fail=None):
        self.calls, self.fail = [], fail
        self.parse_source, self.text_source = parse_source, text_source
        self.replan_sources = replan_sources or {"replan": "bedrock", "text": "bedrock"}

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if self.fail == path:
            return 500, {"error": "boom", "step": path}, 0.5
        if path == "reset":
            return 200, {"deleted": 4}, 0.1
        if path == "alert":
            return 200, {"event_id": "PSPS-DEMO-01", "parse_source": self.parse_source}, 1.0
        if path == "plan":
            return 200, clean_plan(1, {"text": self.text_source}), 12.5
        if path == "replan":
            diff = [{"patient_id": "P001", "field": "action", "from": "transfer", "to": "hospital"}]
            return 200, {"plan": clean_plan(2, self.replan_sources), "diff": diff, "summary": "Two sentences."}, 8.0
        if path == "state":
            return 200, STATE, 0.1
        raise AssertionError(path)


def test_run_once_records_a_clean_run():
    server = Server()
    run = quality.run_once(server, "DaVita Folsom Dialysis")
    assert [c[:2] for c in server.calls] == [("POST", "reset"), ("POST", "alert"), ("POST", "plan"),
                                              ("POST", "replan"), ("GET", "state")]
    assert server.calls[3][2]["instruction"] == "DaVita Folsom Dialysis can only take four more"
    assert "Event ID: PSPS-DEMO-01" in server.calls[1][2]["notice_text"]
    assert run["statuses"] == {"reset": 200, "alert": 200, "plan": 200, "replan": 200, "state": 200}
    assert (run["plan_s"], run["replan_s"]) == (12.5, 8.0)
    assert (run["parse"], run["text"], run["replan"], run["replan_text"]) == ("bedrock",) * 4
    assert run["event_id"] == "PSPS-DEMO-01" and run["plan_version"] == 2
    assert run["clean"] and not any(run[k] for k in ("invented", "schema", "messages", "coverage"))


def test_run_once_counts_defects_and_a_failed_step_does_not_crash():
    class Dirty(Server):
        def __call__(self, method, path, body=None):
            status, data, seconds = super().__call__(method, path, body)
            if path == "plan":
                data["patients"][0]["clinic_id"] = "C99"
            return status, data, seconds
    run = quality.run_once(Dirty(), "X")
    assert run["invented"] == 1 and not run["clean"]
    run = quality.run_once(Server(fail="replan"), "X")
    assert run["statuses"]["replan"] == 500 and run["statuses"]["state"] == 200 and not run["clean"]
    assert run["replan_s"] is None and run["replan"] is None


# summary and table

def run_record(n, clean=True, parse="bedrock", text="bedrock", replan="bedrock", replan_text="bedrock",
               plan_s=10.0, replan_s=5.0, version=2):
    return {"n": n, "statuses": {"reset": 200, "alert": 200, "plan": 200, "replan": 200, "state": 200},
            "plan_s": plan_s, "replan_s": replan_s, "parse": parse, "text": text, "replan": replan,
            "replan_text": replan_text, "event_id": "PSPS-DEMO-01", "plan_version": version,
            "invented": 0, "schema": 0, "messages": 0 if clean else 2, "coverage": 0, "clean": clean}


def test_summary_counts_sources_streak_and_timing():
    runs = [run_record(1, clean=False), run_record(2), run_record(3, parse="fallback", plan_s=30.0),
            run_record(4, replan="fallback", replan_s=9.0), run_record(5, text="fallback", plan_s=20.0)]
    s = quality.summarize(runs)
    assert (s["clean"], s["runs"], s["streak"]) == (4, 5, 4)
    assert s["parse"] == {"bedrock": 4, "fallback": 1}
    assert s["text"] == {"bedrock": 9, "fallback": 1}  # plan text and replan text both count
    assert s["replan"] == {"bedrock": 4, "fallback": 1}
    assert (s["plan_median"], s["plan_max"]) == (10.0, 30.0)
    assert (s["replan_median"], s["replan_max"]) == (5.0, 9.0)
    assert s["best"]["n"] == 2


def test_summary_streak_resets_on_the_last_dirty_run():
    runs = [run_record(1), run_record(2), run_record(3, clean=False)]
    assert quality.summarize(runs)["streak"] == 0


def test_summary_without_an_all_bedrock_clean_run():
    s = quality.summarize([run_record(1, parse="fallback"), run_record(2, clean=False)])
    assert s["best"] is None
    assert "no clean run" in quality.render_summary(s).lower()


def test_summary_best_run_names_event_and_version():
    text = quality.render_summary(quality.summarize([run_record(1, version=2)]))
    assert "PSPS-DEMO-01" in text and "v2" in text and "CloudWatch" in text


def test_table_has_one_row_per_run():
    lines = quality.render_table([run_record(1), run_record(2, clean=False)]).splitlines()
    assert lines[0].startswith("| run") and set(lines[1]) <= set("|- :")
    assert len(lines) == 4
    assert "200/200/200/200/200" in lines[2] and "yes" in lines[2] and "no" in lines[3]


# CLI

def test_missing_url_fails_clearly(monkeypatch):
    monkeypatch.delenv("LUMEN_URL", raising=False)
    monkeypatch.setenv("DEMO_KEY", "k")
    with pytest.raises(SystemExit, match="LUMEN_URL"):
        quality.main([])


def test_missing_key_fails_clearly(monkeypatch):
    monkeypatch.setenv("LUMEN_URL", "https://example.test")
    monkeypatch.delenv("DEMO_KEY", raising=False)
    with pytest.raises(SystemExit, match="DEMO_KEY"):
        quality.main([])


def test_main_warns_first_resets_last_and_never_prints_the_key(monkeypatch, capsys):
    monkeypatch.setenv("LUMEN_URL", "https://example.test/")
    monkeypatch.setenv("DEMO_KEY", "s3cret-demo-key")
    server = Server()
    seen = []

    def call(method, path, body=None):
        if not server.calls:
            seen.append(capsys.readouterr().out)
        return server(method, path, body)
    monkeypatch.setattr(quality, "make_call", lambda url, key: call)
    quality.main(["--runs", "2", "--clinic", "Some Clinic"])
    out = capsys.readouterr().out
    assert "reset" in seen[0].lower() and "shared" in seen[0].lower()
    assert server.calls[-1][:2] == ("POST", "reset")
    assert len([c for c in server.calls if c[1] == "plan"]) == 2
    assert "Some Clinic can only take four more" in json.dumps(server.calls)
    assert "| run" in out and "s3cret-demo-key" not in out + seen[0]


def test_real_client_keeps_the_key_out_of_errors(monkeypatch, capsys):
    key = "s3cret-demo-key"
    sent = []

    def urlopen(req, timeout):
        sent.append(req.get_header("X-demo-key"))
        raise urllib.error.URLError("connection refused")
    monkeypatch.setattr(quality.urllib.request, "urlopen", urlopen)
    status, data, seconds = quality.make_call("https://example.test/", key)("POST", "reset")
    assert sent == [key] and status == 0 and "connection refused" in data["error"]
    assert key not in json.dumps(data)
