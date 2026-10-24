"""Offline text generation checks against the shared plan fixture."""

from copy import deepcopy
import importlib
import json
from pathlib import Path

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
        messages["en"] = (f"{day} {clock}, {place}. {{name}}, your treatment is scheduled. "
                          f"A ride picks you up at {pickup}.")
        if facts["language"] == "es":
            messages["es"] = (f"{day} {clock}, {place}. {{name}}, su tratamiento está programado. "
                              f"Un transporte le recoge a las {pickup}.")
        if facts["language"] == "zh":
            messages["zh"] = f"{day} {clock}，{place}。{{name}}，请于{pickup}出发。"
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
