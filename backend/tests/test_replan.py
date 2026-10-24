"""Offline Converse scripts exercise the AI/tool boundary, never the deployed store."""

from copy import deepcopy
import importlib
import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from botocore.exceptions import BotoCoreError, ClientError
from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "contracts" / "fixtures"
GOOD = "1 patient row changed at C02, H01. New actions: 1 hospital."
CAPACITY = {"clinic_id": "C02", "date": "2026-10-29", "shift": 1, "chairs": 4}


def turn(*requests, text=""):
    uses = [{"id": f"use-{i}", "name": name, "input": args}
            for i, (name, args) in enumerate(requests)]
    content = ([{"toolUse": {"toolUseId": u["id"], "name": u["name"], "input": u["input"]}}
                for u in uses] if uses else [{"text": text}])
    return {"stop_reason": "tool_use" if uses else "end_turn", "tool_uses": uses,
            "text": text, "message": {"role": "assistant", "content": content}}


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv("BEDROCK_MODEL_ID", "test-haiku-4.5")
    plan = json.loads((FIXTURES / "plan.v1.json").read_text())
    next_plan = json.loads((FIXTURES / "plan.v2.json").read_text())
    matched = {k: next_plan[k] for k in ("patients", "overflow")}
    diff = json.loads((FIXTURES / "replan.response.json").read_text())["diff"]
    calls = []

    def tool(name, result):
        def invoke(**kwargs):
            calls.append((name, kwargs))
            return deepcopy(result)
        return Mock(side_effect=invoke)

    capacity_result = {key: value for key, value in CAPACITY.items() if key != "chairs"}
    tools = {"set_clinic_capacity": tool("set_clinic_capacity", {**capacity_result, "open_chairs": 4}),
             "pin_patient": tool("pin_patient", {"patient_id": "P003", "clinic_id": "C02"}),
             "decline_patient": tool("decline_patient", {"patient_id": "P003", "status": "declined"}),
             "rerun_matching": tool("rerun_matching", matched),
             "diff_plans": tool("diff_plans", diff)}
    return plan, tools, calls, matched, diff


def install(monkeypatch, script):
    module = importlib.import_module("lumen.ai.replan")
    seen = []
    responses = iter(script) if not callable(script) else None

    def converse(model_id, system, messages, tools=None, tool_choice=None):
        seen.append(deepcopy({"model_id": model_id, "system": system, "messages": messages,
                              "tools": tools, "tool_choice": tool_choice}))
        assert model_id == "test-haiku-4.5"
        assert tool_choice is None
        return script(len(seen)) if callable(script) else next(responses)

    monkeypatch.setattr(module.bedrock, "converse", converse)
    return module.replan, seen


def tool_results(request):
    return [b["toolResult"] for m in request["messages"] for b in m["content"] if "toolResult" in b]


def test_demo_capacity_per_observed_slot_then_matching_and_diff(monkeypatch, setup):
    plan, tools, calls, matched, diff = setup
    plan["patients"][-1]["slot"] = {"date": "2026-10-29", "shift": 2}
    second = {**CAPACITY, "shift": 2, "chairs": 0}
    script = [turn(("set_clinic_capacity", CAPACITY), ("set_clinic_capacity", second)),
              turn(("rerun_matching", {})), turn(("diff_plans", {})), turn(text=GOOD)]
    replan, seen = install(monkeypatch, script)
    result = replan("C02 can only take four more", plan, tools)
    assert calls == [("set_clinic_capacity", CAPACITY), ("set_clinic_capacity", second),
                     ("rerun_matching", {}), ("diff_plans", {})]
    assert result == {"plan": matched, "diff": diff, "summary": GOOD}
    assert seen[1]["messages"][1] == script[0]["message"]
    assert len(tool_results(seen[1])) == 2
    assert all(r["status"] == "success" for r in tool_results(seen[-1]))
    assert "at most N visiting patients" in seen[0]["system"]


@pytest.mark.parametrize("requests,expected", [
    ([("rerun_matching", {})], ["rerun_matching", "diff_plans"]),
    ([("set_clinic_capacity", CAPACITY)], ["set_clinic_capacity", "rerun_matching", "diff_plans"]),
    ([("diff_plans", {})], ["diff_plans", "rerun_matching", "diff_plans"]),
    ([("rerun_matching", {}), ("diff_plans", {}), ("decline_patient", {"patient_id": "P003"})],
     ["rerun_matching", "diff_plans", "decline_patient", "rerun_matching", "diff_plans"]),
])
def test_finalize_missing_or_stale_results(monkeypatch, setup, requests, expected):
    plan, tools, calls, matched, diff = setup
    replan, seen = install(monkeypatch, [turn(*requests), turn(text="Done."), turn(text=GOOD)])
    result = replan("Adjust C02", plan, tools)
    assert [name for name, _ in calls] == expected
    assert result == {"plan": matched, "diff": diff, "summary": GOOD}
    assert "summary_facts" in json.dumps(seen[-1])


@pytest.mark.parametrize("name,args", [
    ("delete_everything", {}),
    ("decline_patient", {"patient_id": "P003", "extra": True}),
    ("decline_patient", {}),
    ("decline_patient", []),
    ("set_clinic_capacity", {**CAPACITY, "chairs": True}),
    ("set_clinic_capacity", {**CAPACITY, "shift": 5}),
])
def test_invalid_tool_requests_are_errors_and_never_execute(monkeypatch, setup, name, args):
    plan, tools, calls, _, _ = setup
    replan, seen = install(monkeypatch, [turn((name, args)), turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools)
    error = tool_results(seen[1])[0]
    assert error["status"] == "error" and error["toolUseId"] == "use-0"
    assert calls == [("rerun_matching", {}), ("diff_plans", {})]


@pytest.mark.parametrize("name,args", [
    ("decline_patient", {"patient_id": "P999"}),
    ("set_clinic_capacity", {**CAPACITY, "clinic_id": "C99"}),
])
def test_invented_ids_take_error_path(monkeypatch, setup, name, args):
    plan, tools, _, _, _ = setup
    replan, seen = install(monkeypatch, [turn((name, args)), turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools)
    assert tool_results(seen[1])[0]["status"] == "error"
    tools[name].assert_not_called()


@pytest.mark.parametrize("error,expected", [
    (ValueError("C02 holds pinned or confirmed patients"), "C02 holds pinned or confirmed patients"),
    (RuntimeError("private database password traceback"), "Tool failed"),
])
def test_tool_errors_are_readable_or_generic(monkeypatch, setup, error, expected):
    plan, tools, _, _, _ = setup
    tools["set_clinic_capacity"].side_effect = error
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", CAPACITY)),
                                       turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools)
    result = tool_results(seen[1])[0]
    assert result["status"] == "error"
    assert expected in json.dumps(result)
    assert "private database" not in json.dumps(seen)


def test_seventh_call_is_refused_and_no_partial_plan_is_returned(monkeypatch, setup):
    plan, tools, calls, _, _ = setup

    def endless(number):
        # Bounded fake makes a removed production cap fail promptly, not hang.
        assert number <= 7, "model called beyond the test sentinel"
        return turn(("decline_patient", {"patient_id": "P003"}))

    replan, seen = install(monkeypatch, endless)
    with pytest.raises(RuntimeError, match="6|six"):
        replan("Decline P003", plan, tools)
    assert len(seen) == 6
    assert not any(name == "rerun_matching" for name, _ in calls)


@pytest.mark.parametrize("bad", ["Done.", "99 rows changed at C02, H01. New actions: 1 hospital.",
                                  "1 row changed at C02, H01. New actions: 9 hospital.",
                                  "1 row changed at C02, H01. New actions: 1 hospital. Done."])
def test_summary_has_one_retry(monkeypatch, setup, bad):
    plan, tools, _, _, _ = setup
    replan, seen = install(monkeypatch, [turn(("rerun_matching", {}), ("diff_plans", {})),
                                       turn(text=bad), turn(text=GOOD)])
    assert replan("Adjust C02", plan, tools)["summary"] == GOOD
    assert len(seen) == 3


def test_summary_template_after_retry(monkeypatch, setup):
    plan, tools, _, _, _ = setup
    replan, seen = install(monkeypatch, [turn(("rerun_matching", {}), ("diff_plans", {})),
                                       turn(text="99 rows changed."), turn(text="Still wrong.")])
    summary = replan("Adjust C02", plan, tools)["summary"]
    assert summary == GOOD
    assert len(seen) == 3


def test_summary_retry_never_exceeds_global_budget(monkeypatch, setup):
    plan, tools, _, _, _ = setup
    replan, seen = install(monkeypatch, [turn(("decline_patient", {"patient_id": "P003"}))] * 4
                          + [turn(("rerun_matching", {}), ("diff_plans", {})), turn(text="Wrong.")])
    assert replan("Adjust C02", plan, tools)["summary"] == GOOD
    assert len(seen) == 6


def test_no_names_or_home_locations_reach_any_converse_call(monkeypatch, setup):
    plan, tools, _, matched, _ = setup
    for value in (plan, matched):
        value["patients"][0].update(name="Private Patient", home={"lat": 38.731234, "lng": -120.791234})
    tools["rerun_matching"].side_effect = lambda: deepcopy(matched)
    before = deepcopy(plan)
    replan, seen = install(monkeypatch, [turn(("rerun_matching", {})), turn(("diff_plans", {})),
                                       turn(text="Wrong."), turn(text=GOOD)])
    result = replan("Adjust C02", plan, tools)
    wire = json.dumps(seen)
    for secret in ("Private Patient", "38.731234", "-120.791234", "Maria Delgado", "Chen Wei",
                   "James Whitfield", "Linda Park", "2195 Iron Point", "reason_text"):
        assert secret not in wire
    assert plan == before
    assert result["plan"] == matched


@pytest.mark.parametrize("error", [ClientError({"Error": {"Code": "AccessDeniedException", "Message": "denied"}},
                                             "Converse"), BotoCoreError()])
def test_bedrock_errors_propagate(monkeypatch, setup, error):
    plan, tools, _, _, _ = setup

    def fail(_number):
        raise error

    replan, seen = install(monkeypatch, fail)
    with pytest.raises(type(error)) as caught:
        replan("Adjust C02", plan, tools)
    assert caught.value is error and len(seen) == 1


def test_missing_model_id_is_clear(monkeypatch, setup):
    plan, tools, _, _, _ = setup
    replan, seen = install(monkeypatch, [])
    monkeypatch.delenv("BEDROCK_MODEL_ID")
    with pytest.raises(ValueError, match="BEDROCK_MODEL_ID"):
        replan("Adjust C02", plan, tools)
    assert seen == []


def test_contract_and_exact_strict_schemas(monkeypatch, setup):
    plan, tools, _, matched, diff = setup
    replan, seen = install(monkeypatch, [turn(text="Done."), turn(text=GOOD)])
    result = replan("Adjust C02", plan, tools)
    schema = json.loads((ROOT / "contracts/schemas/replan.schema.json").read_text())
    Draft202012Validator(schema).validate(result)
    assert set(result["plan"]) == {"patients", "overflow"}
    assert result["plan"] == matched and result["diff"] == diff
    expected = {"set_clinic_capacity": {"clinic_id", "date", "shift", "chairs"},
                "pin_patient": {"patient_id", "clinic_id", "date", "shift"},
                "decline_patient": {"patient_id"}, "rerun_matching": set(), "diff_plans": set()}
    specs = {s["toolSpec"]["name"]: s["toolSpec"]["inputSchema"]["json"] for s in seen[0]["tools"]}
    assert set(specs) == set(expected)
    for name, args in expected.items():
        assert set(specs[name]["required"]) == set(specs[name]["properties"]) == args
        assert specs[name]["additionalProperties"] is False


@pytest.mark.parametrize("bad", [
    "-1 patient row changed at C02, H01. New actions: -1 hospital.",
    "1 patient row changed at C020, H010. New actions: 1 hospital.",
    "1 patient row changed at C02, H01, C99. New actions: 1 hospital.",
])
def test_summary_rejects_signed_counts_and_invented_clinics(monkeypatch, setup, bad):
    plan, tools, _, _, _ = setup
    replan, seen = install(monkeypatch, [turn(("rerun_matching", {}), ("diff_plans", {})),
                                       turn(text=bad), turn(text=GOOD)])
    assert replan("Adjust C02", plan, tools)["summary"] == GOOD
    assert len(seen) == 3


def test_diff_tool_result_contains_exact_diff_and_summary_facts(monkeypatch, setup):
    plan, tools, _, _, diff = setup
    replan, seen = install(monkeypatch, [turn(("rerun_matching", {}), ("diff_plans", {})), turn(text=GOOD)])
    replan("Adjust C02", plan, tools)
    content = tool_results(seen[1])[-1]["content"][0]["json"]
    assert content["diff"] == diff
    assert content["summary_facts"] == {"changed_rows": 1, "clinics": ["C02", "H01"],
                                         "new_actions": {"hospital": 1}}


def test_missing_context_signal_falls_back_instead_of_returning_unchanged_plan(monkeypatch, setup):
    plan, tools, calls, _, _ = setup
    replan, seen = install(monkeypatch, [turn(text="REPLAN_CONTEXT_UNAVAILABLE"), turn(text=GOOD)])
    with pytest.raises(RuntimeError, match="context"):
        replan("DaVita Folsom Dialysis can only take four more", plan, tools)
    assert calls == [] and len(seen) == 1
