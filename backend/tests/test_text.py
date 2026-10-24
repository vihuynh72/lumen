"""Offline text generation checks against the shared plan fixture."""

from copy import deepcopy
import importlib
import json
from pathlib import Path
from threading import Barrier, Event, Lock

import pytest
from botocore.exceptions import ClientError


FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
LANGS = {"P001": "es", "P002": "en", "P003": "zh", "P004": "en", "P005": "en"}


@pytest.fixture
def inputs(monkeypatch):
    monkeypatch.setenv("BEDROCK_MODEL_FAST", "test-fast")
    return (json.loads((FIXTURES / "plan.v1.json").read_text()),
            json.loads((FIXTURES / "state.json").read_text())["clinics"], LANGS.copy())


def generated(facts):
    messages = {}
    if facts["time"]:
        day, clock, place, pickup = (facts[k] for k in ("day", "time", "clinic_name", "pickup_time"))
        own_ride = facts["ride"] in ("self", "family")
        ride = f"Please leave home by {pickup}." if own_ride else f"A ride picks you up at {pickup}."
        messages["en"] = (f"{day} {clock}, {place}. {{name}}, your treatment is scheduled. "
                          + ride)
        if facts["language"] == "es":
            viaje = f"Salga de casa a las {pickup}." if own_ride else f"Un transporte le recoge a las {pickup}."
            messages["es"] = (f"{day} {clock}, {place}. {{name}}, su tratamiento está programado. "
                              + viaje)
        if facts["language"] == "zh":
            travel = "出发" if own_ride else "等候接送"
            messages["zh"] = f"{day} {clock}，{place}。{{name}}，请于{pickup}{travel}。"
    return {"patient_id": facts["patient_id"], "reason_text": facts["reason_text"], "messages": messages}


def response(payload):
    value = ({"patients": [generated(row) for row in payload["patients"]]}
             if "patients" in payload else {"summary": payload["summary"]})
    return {"stop_reason": "tool_use", "tool_uses": [{"name": "write_plan_text", "input": value}]}


def install(monkeypatch, change=None):
    module = importlib.import_module("lumen.ai.text")
    calls = []

    def converse(model_id, system, messages, tools=None, tool_choice=None):
        assert model_id == "test-fast"
        assert tool_choice == "write_plan_text"
        assert [tool["toolSpec"]["name"] for tool in tools] == ["write_plan_text"]
        payload = json.loads(messages[0]["content"][0]["text"])
        calls.append(payload)
        result = response(payload)
        return change(payload, result) if change else result

    monkeypatch.setattr(module.bedrock, "converse", converse)
    return module.write_plan_text, calls


def test_clean_three_languages_and_counted_summary(monkeypatch, inputs):
    write, calls = install(monkeypatch)
    plan, clinics, langs = inputs
    result = write(plan, clinics, langs)
    assert len(calls) == 2
    expected = [generated(row) for row in calls[0]["patients"]]
    for row, text in zip(result["patients"], expected):
        assert row["reason_text"] == text["reason_text"]
        assert row["messages"] == text["messages"]
        assert list(row["messages"]) == (["en", langs[row["patient_id"]]]
                                        if langs[row["patient_id"]] != "en" else
                                        (["en"] if row["slot"] else []))
        assert {k: v for k, v in row.items() if k not in ("messages", "reason_text")} == {
            k: v for k, v in plan["patients"][row["rank"] - 1].items()
            if k not in ("messages", "reason_text")}
    assert calls[1]["counts"] == {"early_session": "2", "transfer": "2", "hospital": "1", "book_today": "1"}
    assert result["summary"] == calls[1]["summary"]
    assert result["summary"].count(".") == 2


def test_only_ids_and_input_are_preserved(monkeypatch, inputs):
    write, calls = install(monkeypatch)
    before = deepcopy(inputs)
    result = write(*inputs, only_ids=["P001"])
    assert inputs == before
    assert result is not inputs[0]
    assert len(calls) == 1
    assert [r["patient_id"] for r in calls[0]["patients"]] == ["P001"]
    assert result["summary"] == before[0]["summary"]
    for old, new in zip(before[0]["patients"], result["patients"]):
        if old["patient_id"] != "P001":
            assert new == old
    result["patients"][0]["flags"].append("changed copy")
    assert inputs == before


def test_no_names_or_home_locations_reach_converse(monkeypatch, inputs):
    module = importlib.import_module("lumen.ai.text")
    inputs[0]["patients"][0].update(name="Private Patient", home={"lat": 38.731234, "lng": -120.791234})
    inputs[0]["audit"] = [{"change": "Private Patient at 38.731234"}]
    seen = []

    def spy(*args, **kwargs):
        seen.append(json.dumps([args, kwargs], ensure_ascii=False))
        return response(json.loads(args[2][0]["content"][0]["text"]))

    monkeypatch.setattr(module.bedrock, "converse", spy)
    module.write_plan_text(*inputs)
    for value in ("Private Patient", "38.731234", "-120.791234", "Maria Delgado", "Chen Wei", "James Whitfield", "Linda Park"):
        assert all(value not in call for call in seen)


def test_client_error_propagates(monkeypatch, inputs):
    error = ClientError({"Error": {"Code": "ThrottlingException", "Message": "quota"}}, "Converse")

    def fail(*_):
        raise error

    write, calls = install(monkeypatch, fail)
    with pytest.raises(ClientError) as caught:
        write(*inputs)
    assert caught.value is error
    assert len(calls) == 1


def test_missing_model_is_clear(monkeypatch, inputs):
    write, calls = install(monkeypatch)
    monkeypatch.delenv("BEDROCK_MODEL_FAST")
    with pytest.raises(ValueError, match="BEDROCK_MODEL_FAST"):
        write(*inputs)
    assert calls == []


def corrupt(result, defect):
    rows = result["tool_uses"][0]["input"]["patients"]
    if defect == "invented_id":
        rows[0]["patient_id"] = "P999"
    elif defect == "missing_row":
        rows.pop()
    elif defect == "duplicate_row":
        rows.append(deepcopy(rows[0]))
    elif defect == "long_en":
        rows[0]["messages"]["en"] += " please" * 40
    elif defect == "long_zh":
        rows[2]["messages"]["zh"] += "请" * 81
    elif defect.startswith("banned:"):
        _, lang, word = defect.split(":")
        row = next(row for row in rows if lang in row["messages"])
        row["messages"][lang] += " " + word
    elif defect == "wrong_time":
        rows[0]["messages"]["en"] = rows[0]["messages"]["en"].replace("05:15", "23:59")
    elif defect == "extra_time":
        rows[0]["messages"]["en"] += " Come at 11:42 PM."
    elif defect == "wrong_language":
        rows[1]["messages"]["es"] = rows[1]["messages"]["en"]
    elif defect == "traditional_zh":
        rows[2]["messages"]["zh"] = rows[2]["messages"]["zh"].replace("请", "請")
    elif defect == "missing_name":
        rows[0]["messages"]["en"] = rows[0]["messages"]["en"].replace("{name}", "")
    elif defect == "extra_name":
        rows[0]["messages"]["en"] += " {name}"
    elif defect == "invented_reason":
        rows[0]["reason_text"] = "The clinic is 99 miles away."
    elif defect == "changed_rank":
        rows[0]["rank"] = 999
    elif defect == "hospital_message":
        rows[3]["messages"] = {"en": rows[0]["messages"]["en"]}
    elif defect == "clock_roles":
        rows[0]["messages"]["en"] = ("2026-10-27 06:00, DaVita Cameron Park Dialysis. "
                                     "{name}, your treatment is at 05:15. A ride picks you up at 06:00.")
    elif defect == "pickup_claimed_as_treatment":
        rows[0]["messages"]["en"] = ("2026-10-27 06:00, DaVita Cameron Park Dialysis. "
                                     "{name}, your treatment is at 05:15.")
    elif defect == "invented_ride":
        rows[0]["messages"]["en"] = rows[0]["messages"]["en"].replace("Please leave home by", "A ride picks you up at")
    elif defect == "missing_ride":
        rows[1]["messages"]["en"] = rows[1]["messages"]["en"].replace("A ride picks you up at", "Please leave home by")


@pytest.mark.parametrize("defect", [
    "invented_id", "missing_row", "duplicate_row", "long_en", "long_zh",
    "banned:en:death", "banned:en:danger", "banned:en:risk",
    "banned:es:muerte", "banned:es:peligro", "banned:es:riesgo",
    "banned:zh:死亡", "banned:zh:危险", "banned:zh:风险",
    "wrong_time", "extra_time", "wrong_language", "traditional_zh", "missing_name", "extra_name",
    "invented_reason", "changed_rank", "hospital_message",
    "clock_roles", "pickup_claimed_as_treatment", "invented_ride", "missing_ride",
])
def test_invalid_batch_retries_once(monkeypatch, inputs, defect):
    attempts = []

    def change(payload, result):
        if "patients" in payload:
            attempts.append(payload)
            if len(attempts) == 1:
                corrupt(result, defect)
        return result

    write, _ = install(monkeypatch, change)
    result = write(*inputs)
    assert len(attempts) == 2
    assert attempts[1]["errors"]
    for row, facts in zip(result["patients"], attempts[1]["patients"]):
        assert {k: row[k] for k in ("patient_id", "reason_text", "messages")} == generated(facts)


def test_second_failure_templates_only_bad_row(monkeypatch, inputs, caplog):
    def change(payload, result):
        if "patients" in payload:
            corrupt(result, "wrong_time")
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs)
    batches = [call for call in calls if "patients" in call]
    assert len(batches) == 2
    assert "23:59" not in result["patients"][0]["messages"]["en"]
    assert "05:15" in result["patients"][0]["messages"]["en"]
    assert "555-0100" in result["patients"][0]["messages"]["en"]
    for row, facts in zip(result["patients"][1:], batches[-1]["patients"][1:]):
        assert row["messages"] == generated(facts)["messages"]
    assert "P002" in caplog.text
    assert "P001" not in caplog.text
    assert "23:59" not in caplog.text


def test_summary_retries_then_uses_only_code_counts(monkeypatch, inputs):
    def change(payload, result):
        if "summary" in payload:
            result["tool_uses"][0]["input"]["summary"] = "99 patients moved. Book 88 rides."
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs)
    summaries = [call for call in calls if "summary" in call]
    assert len(summaries) == 2
    assert result["summary"] == summaries[-1]["summary"]
    assert "99" not in result["summary"]


def test_notify_only_never_gets_a_message(monkeypatch, inputs):
    inputs[0]["patients"][0].update(action="notify_only", slot=None, clinic_id=None, pickup_time=None)

    def change(payload, result):
        if "patients" in payload:
            result["tool_uses"][0]["input"]["patients"][0]["messages"] = {"en": "Wrong message"}
        return result

    write, _ = install(monkeypatch, change)
    result = write(*inputs)
    assert result["patients"][0]["messages"] == {}
    assert result["patients"][0]["reason_text"]


def test_max_tokens_batch_splits(monkeypatch, inputs):
    def truncate(payload, result):
        return {"stop_reason": "max_tokens"} if len(payload["patients"]) > 3 else result

    write, calls = install(monkeypatch, truncate)
    result = write(*inputs, only_ids=list(LANGS))
    assert [len(call["patients"]) for call in calls] == [5, 2, 3]
    assert [row["patient_id"] for row in result["patients"]] == [row["patient_id"] for row in inputs[0]["patients"]]


def test_max_tokens_singletons_are_bounded(monkeypatch, inputs):
    inputs[0]["patients"] = inputs[0]["patients"][:2]
    write, calls = install(monkeypatch, lambda *_: {"stop_reason": "max_tokens"})
    result = write(*inputs, only_ids=["P001", "P002"])
    assert [len(call["patients"]) for call in calls] == [2, 1, 1, 1, 1]
    assert all(row["messages"]["en"] for row in result["patients"])


def test_parallel_batches_are_bounded_and_ordered(monkeypatch, inputs):
    original = inputs[0]["patients"][0]
    inputs[0]["patients"] = [{**deepcopy(original), "patient_id": f"P{i:03}", "rank": i}
                             for i in range(1, 43)]
    inputs = (inputs[0], inputs[1], {f"P{i:03}": "en" for i in range(1, 43)})
    barrier, later_finished, lock = Barrier(4, timeout=3), Event(), Lock()
    active = peak = 0

    def finish_out_of_order(payload, result):
        nonlocal active, peak
        rows = payload["patients"]
        assert len(rows) <= 10
        with lock:
            active += 1
            peak = max(peak, active)
        if rows[0]["rank"] <= 31:
            barrier.wait()
        if rows[0]["rank"] == 1:
            assert later_finished.wait(3)
        else:
            later_finished.set()
        with lock:
            active -= 1
        result["tool_uses"][0]["input"]["patients"].reverse()
        return result

    write, calls = install(monkeypatch, finish_out_of_order)
    result = write(*inputs, only_ids=list(inputs[2]))
    assert peak == 4
    assert sorted(len(call["patients"]) for call in calls) == [2, 10, 10, 10, 10]
    assert [row["patient_id"] for row in result["patients"]] == list(inputs[2])
    for row in result["patients"]:
        assert row["reason_text"]
