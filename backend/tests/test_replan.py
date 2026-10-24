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
SUMMARY = "1 patient row changed at DaVita Folsom Dialysis, Mercy Hospital of Folsom. New actions: 1 hospital."
CAPACITY = {"clinic_id": "C02", "date": "2026-10-29", "shift": 1, "chairs": 4}
PIN = ("pin_patient", {"patient_id": "P003", "clinic_id": "C02", "date": "2026-10-29", "shift": 1})


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
    clinics = json.loads((FIXTURES / "state.json").read_text())["clinics"]
    return plan, tools, calls, matched, diff, clinics


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


def test_demo_clinic_name_capacity_per_slot_then_matching_and_diff(monkeypatch, setup):
    plan, tools, calls, matched, diff, clinics = setup
    clinic = next(c for c in clinics if c["id"] == "C02")
    slots = clinic["slots"]
    # Five visitors; keep four by rank, three in the first slot and one in the second.
    plan["patients"] = [{**row, "clinic_id": "C02", "slot": {
        "date": slots[0 if i < 3 or i == 4 else 1]["date"],
        "shift": slots[0 if i < 3 or i == 4 else 1]["shift"],
    }} for i, row in enumerate(plan["patients"])]
    capacities = [("set_clinic_capacity", {"clinic_id": "C02", "date": slot["date"],
                   "shift": slot["shift"], "chairs": 3 if i == 0 else 1 if i == 1 else 0})
                  for i, slot in enumerate(slots)]
    script = [turn(*capacities), turn(("rerun_matching", {})), turn(("diff_plans", {})), turn(text=GOOD)]
    replan, seen = install(monkeypatch, script)
    result = replan("DaVita Folsom Dialysis can only take four more", plan, tools, clinics)
    assert calls == [*capacities, ("rerun_matching", {}), ("diff_plans", {})]
    assert sum(args["chairs"] for _, args in capacities) == 4
    assert result == {"plan": matched, "diff": diff, "summary": SUMMARY}
    payload = json.loads(seen[0]["messages"][0]["content"][0]["text"])
    expected_clinics = [{key: c[key] for key in ("id", "name", "kind", "home", "slots")} for c in clinics]
    assert payload["clinics"] == expected_clinics
    assert payload["instruction"] == "DaVita Folsom Dialysis can only take four more"
    assert seen[1]["messages"][1] == script[0]["message"]
    assert len(tool_results(seen[1])) == len(slots)
    assert all(r["status"] == "success" for r in tool_results(seen[-1]))
    assert "at most N visiting patients" in seen[0]["system"]


@pytest.mark.parametrize("requests,expected", [
    ([PIN, ("rerun_matching", {})], ["pin_patient", "rerun_matching", "diff_plans"]),
    ([("set_clinic_capacity", CAPACITY)], ["set_clinic_capacity", "rerun_matching", "diff_plans"]),
    ([PIN, ("diff_plans", {})], ["pin_patient", "diff_plans", "rerun_matching", "diff_plans"]),
    ([("rerun_matching", {}), ("diff_plans", {}), ("decline_patient", {"patient_id": "P003"})],
     ["rerun_matching", "diff_plans", "decline_patient", "rerun_matching", "diff_plans"]),
])
def test_finalize_missing_or_stale_results(monkeypatch, setup, requests, expected):
    plan, tools, calls, matched, diff, clinics = setup
    replan, seen = install(monkeypatch, [turn(*requests), turn(text="Done."), turn(text=GOOD)])
    result = replan("Adjust C02", plan, tools, clinics)
    assert [name for name, _ in calls] == expected
    assert result == {"plan": matched, "diff": diff, "summary": SUMMARY}
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
    plan, tools, calls, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn((name, args)), turn(PIN), turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools, clinics)
    error = tool_results(seen[1])[0]
    assert error["status"] == "error" and error["toolUseId"] == "use-0"
    assert calls == [PIN, ("rerun_matching", {}), ("diff_plans", {})]


@pytest.mark.parametrize("name,args", [
    ("decline_patient", {"patient_id": "P999"}),
    ("set_clinic_capacity", {**CAPACITY, "clinic_id": "C99"}),
])
def test_invented_ids_take_error_path(monkeypatch, setup, name, args):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn((name, args)), turn(PIN), turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    tools[name].assert_not_called()


@pytest.mark.parametrize("error,expected", [
    (ValueError("C02 holds pinned or confirmed patients"), "C02 holds pinned or confirmed patients"),
    (RuntimeError("private database password traceback"), "Tool failed"),
])
def test_tool_errors_are_readable_or_generic(monkeypatch, setup, error, expected):
    plan, tools, _, _, _, clinics = setup
    tools["set_clinic_capacity"].side_effect = error
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", CAPACITY)), turn(PIN),
                                       turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools, clinics)
    result = tool_results(seen[1])[0]
    assert result["status"] == "error"
    assert expected in json.dumps(result)
    assert "private database" not in json.dumps(seen)


def test_seventh_call_is_refused_and_no_partial_plan_is_returned(monkeypatch, setup):
    plan, tools, calls, _, _, clinics = setup

    def endless(number):
        # Bounded fake makes a removed production cap fail promptly, not hang.
        assert number <= 7, "model called beyond the test sentinel"
        return turn(("decline_patient", {"patient_id": "P003"}))

    replan, seen = install(monkeypatch, endless)
    with pytest.raises(RuntimeError, match="6|six"):
        replan("Decline P003", plan, tools, clinics)
    assert len(seen) == 6
    assert not any(name == "rerun_matching" for name, _ in calls)


@pytest.mark.parametrize("bad", ["Done.", "99 rows changed at C02, H01. New actions: 1 hospital.",
                                  "1 row changed at C02, H01. New actions: 9 hospital.",
                                  "1 row changed at C02, H01. New actions: 1 hospital. Done."])
def test_summary_has_one_retry(monkeypatch, setup, bad):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN, ("rerun_matching", {}), ("diff_plans", {})),
                                       turn(text=bad), turn(text=GOOD)])
    assert replan("Adjust C02", plan, tools, clinics)["summary"] == SUMMARY
    assert len(seen) == 3


def test_summary_template_after_retry(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN, ("rerun_matching", {}), ("diff_plans", {})),
                                       turn(text="99 rows changed."), turn(text="Still wrong.")])
    summary = replan("Adjust C02", plan, tools, clinics)["summary"]
    assert summary == SUMMARY
    assert len(seen) == 3


def test_summary_retry_never_exceeds_global_budget(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(("decline_patient", {"patient_id": "P003"}))] * 4
                          + [turn(PIN, ("rerun_matching", {}), ("diff_plans", {})), turn(text="Wrong.")])
    assert replan("Adjust C02", plan, tools, clinics)["summary"] == SUMMARY
    assert len(seen) == 6


def test_no_names_or_home_locations_reach_any_converse_call(monkeypatch, setup):
    plan, tools, _, matched, _, clinics = setup
    for value in (plan, matched):
        value["patients"][0].update(name="Private Patient", home={"lat": 38.731234, "lng": -120.791234})
    tools["rerun_matching"].side_effect = lambda: deepcopy(matched)
    clinics[0].update(address="Private clinic address", phone="555-private", lat=38.731234)
    clinics[0]["slots"][0]["note"] = "Private clinic slot note"
    before = deepcopy(plan)
    clinics_before = deepcopy(clinics)
    replan, seen = install(monkeypatch, [turn(PIN, ("rerun_matching", {})), turn(("diff_plans", {})),
                                       turn(text="Wrong."), turn(text=GOOD)])
    result = replan("Adjust C02", plan, tools, clinics)
    wire = json.dumps(seen)
    for secret in ("Private Patient", "38.731234", "-120.791234", "Maria Delgado", "Chen Wei",
                   "James Whitfield", "Linda Park", "2195 Iron Point", "reason_text",
                   "Private clinic address", "555-private", "Private clinic slot note"):
        assert secret not in wire
    assert plan == before
    assert clinics == clinics_before
    assert result["plan"] == matched


@pytest.mark.parametrize("error", [ClientError({"Error": {"Code": "AccessDeniedException", "Message": "denied"}},
                                             "Converse"), BotoCoreError()])
def test_bedrock_errors_propagate(monkeypatch, setup, error):
    plan, tools, _, _, _, clinics = setup

    def fail(_number):
        raise error

    replan, seen = install(monkeypatch, fail)
    with pytest.raises(type(error)) as caught:
        replan("Adjust C02", plan, tools, clinics)
    assert caught.value is error and len(seen) == 1


def test_missing_model_id_is_clear(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [])
    monkeypatch.delenv("BEDROCK_MODEL_ID")
    with pytest.raises(ValueError, match="BEDROCK_MODEL_ID"):
        replan("Adjust C02", plan, tools, clinics)
    assert seen == []


def test_contract_and_exact_strict_schemas(monkeypatch, setup):
    plan, tools, _, matched, diff, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN), turn(text="Done."), turn(text=GOOD)])
    result = replan("Adjust C02", plan, tools, clinics)
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
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN, ("rerun_matching", {}), ("diff_plans", {})),
                                       turn(text=bad), turn(text=GOOD)])
    assert replan("Adjust C02", plan, tools, clinics)["summary"] == SUMMARY
    assert len(seen) == 3


def test_diff_tool_result_contains_exact_diff_and_summary_facts(monkeypatch, setup):
    plan, tools, _, _, diff, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN, ("rerun_matching", {}), ("diff_plans", {})), turn(text=GOOD)])
    replan("Adjust C02", plan, tools, clinics)
    content = tool_results(seen[1])[-1]["content"][0]["json"]
    assert content["diff"] == diff
    assert content["summary_facts"] == {"changed_rows": 1, "clinics": ["C02", "H01"],
                                         "new_actions": {"hospital": 1}}


@pytest.mark.parametrize("explicit", [False, True])
def test_missing_clinics_rejects_before_model_lookup_or_converse(monkeypatch, setup, explicit):
    plan, tools, calls, _, _, _ = setup
    replan, seen = install(monkeypatch, [])
    monkeypatch.delenv("BEDROCK_MODEL_ID")
    with pytest.raises(ValueError, match="^clinic context missing$"):
        replan("DaVita Folsom Dialysis can only take four more", plan, tools, **({"clinics": None} if explicit else {}))
    assert seen == calls == []


@pytest.mark.parametrize("requests", [[], [("rerun_matching", {}), ("diff_plans", {})],
                                      [("set_clinic_capacity", {**CAPACITY, "clinic_id": "C99"})]])
def test_unknown_clinic_name_without_mutation_falls_back(monkeypatch, setup, requests):
    plan, tools, calls, _, _, clinics = setup
    script = ([turn(*requests)] if requests else []) + [turn(text="I cannot find that clinic."), turn(text=GOOD)]
    replan, seen = install(monkeypatch, script)
    with pytest.raises(ValueError, match="^instruction not understood$"):
        replan("Invented Clinic can only take four more", plan, tools, clinics)
    assert len(seen) == (2 if requests else 1)
    assert [name for name, _ in calls] == [name for name, _ in requests if name in ("rerun_matching", "diff_plans")]


def test_failed_mutation_does_not_count_as_understood(monkeypatch, setup):
    plan, tools, calls, _, _, clinics = setup
    tools["set_clinic_capacity"].side_effect = ValueError("C02 holds pinned patients")
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", CAPACITY)), turn(text="Done."), turn(text=GOOD)])
    with pytest.raises(ValueError, match="^instruction not understood$"):
        replan("DaVita Folsom Dialysis can only take four more", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    assert calls == []


@pytest.mark.parametrize("slot", [{"date": "2099-01-01", "shift": 1}, {"date": "2026-10-29", "shift": 4},
                                   {"date": "2026-10-27", "shift": 2, "clinic_id": "H01"}])
def test_capacity_slot_must_belong_to_supplied_clinic(monkeypatch, setup, slot):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", {**CAPACITY, **slot})),
                                       turn(PIN), turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    tools["set_clinic_capacity"].assert_not_called()


def test_assigned_clinic_omitted_from_supplied_context_is_rejected(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    clinics = [c for c in clinics if c["id"] != "C02"]
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", CAPACITY)),
                                       turn(("decline_patient", {"patient_id": "P003"})),
                                       turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    tools["set_clinic_capacity"].assert_not_called()


def test_pin_rejects_hallucinated_clinic_id(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(("pin_patient", {**PIN[1], "clinic_id": "C99"})),
                                       turn(("decline_patient", {"patient_id": "P003"})),
                                       turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    tools["pin_patient"].assert_not_called()


def test_supplied_clinic_without_assignments_is_available(monkeypatch, setup):
    plan, tools, calls, _, _, clinics = setup
    clinic = {**clinics[1], "id": "C03", "name": "Receiving Clinic"}
    args = {**CAPACITY, "clinic_id": "C03"}
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", args)), turn(text="Done."), turn(text=GOOD)])
    replan("Receiving Clinic can only take four more", plan, tools, [*clinics, clinic])
    assert calls[0] == ("set_clinic_capacity", args)
    assert tool_results(seen[1])[0]["status"] == "success"


@pytest.mark.parametrize("name,args,extra", [
    ("decline_patient", {"patient_id": "P999"}, {"patient_id": "P999", "clinic_id": "C02"}),
    ("set_clinic_capacity", {**CAPACITY, "clinic_id": "C99"}, {"patient_id": "P003", "clinic_id": "C99"}),
])
def test_tool_results_do_not_expand_authorized_ids(monkeypatch, setup, name, args, extra):
    plan, tools, _, matched, _, clinics = setup
    tools["rerun_matching"].side_effect = lambda: {**matched, "patients": [*matched["patients"], extra]}
    replan, seen = install(monkeypatch, [turn(PIN, ("rerun_matching", {})), turn((name, args)),
                                       turn(text="Done."), turn(text=GOOD)])
    replan("Adjust C02", plan, tools, clinics)
    assert tool_results(seen[2])[-1]["status"] == "error"
    tools[name].assert_not_called()
