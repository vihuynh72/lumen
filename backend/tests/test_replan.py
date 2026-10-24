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
SUMMARY = "1 patient row changed at DaVita Folsom Dialysis, Mercy Hospital of Folsom. New actions: 1 patient needs a staff call; 1 pickup change."
CAPACITY = {"clinic_id": "C02", "date": "2026-10-29", "shift": 1, "chairs": 2}
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
    slots[0]["open_chairs"] = slots[1]["open_chairs"] = 3
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
    result = replan("Adjust C02 and pin P003", plan, tools, clinics)
    assert [name for name, _ in calls] == expected
    assert result == {"plan": matched, "diff": diff, "summary": SUMMARY}
    assert len(seen) == 2


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
    if name == "delete_everything":
        replan("Adjust C02 and pin P003", plan, tools, clinics)
    else:
        with pytest.raises(RuntimeError, match="partial re-plan"):
            replan("Adjust C02 and pin P003", plan, tools, clinics)
    error = tool_results(seen[1])[0]
    assert error["status"] == "error" and error["toolUseId"] == "use-0"
    assert calls == ([PIN, ("rerun_matching", {}), ("diff_plans", {})] if name == "delete_everything" else [PIN])


@pytest.mark.parametrize("name,args", [
    ("decline_patient", {"patient_id": "P999"}),
    ("set_clinic_capacity", {**CAPACITY, "clinic_id": "C99"}),
])
def test_invented_ids_take_error_path(monkeypatch, setup, name, args):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn((name, args)), turn(PIN), turn(text="Done."), turn(text=GOOD)])
    with pytest.raises(RuntimeError, match="partial re-plan"):
        replan("Adjust C02 and pin P003", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    tools[name].assert_not_called()


@pytest.mark.parametrize("error,expected", [
    (ValueError("C02 holds pinned or confirmed patients"), "Tool failed"),
    (RuntimeError("private database password traceback"), "Tool failed"),
])
def test_tool_errors_are_readable_or_generic(monkeypatch, setup, error, expected):
    plan, tools, _, _, _, clinics = setup
    tools["set_clinic_capacity"].side_effect = error
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", CAPACITY)), turn(PIN),
                                       turn(text="Done."), turn(text=GOOD)])
    with pytest.raises(RuntimeError, match="partial re-plan"):
        replan("Adjust C02 and pin P003", plan, tools, clinics)
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


def test_summary_is_built_from_diff_without_another_model_call(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN), turn(text="P999 goes to Invented Clinic.")])
    summary = replan("Pin P003 to C02", plan, tools, clinics)["summary"]
    assert summary == SUMMARY
    assert "P999" not in summary and "Invented" not in summary
    assert len(seen) == 2


def test_no_names_or_home_locations_reach_any_converse_call(monkeypatch, setup):
    plan, tools, _, matched, _, clinics = setup
    for value in (plan, matched):
        value["patients"][0].update(name="Private Patient", home={"lat": 38.731234, "lng": -120.791234})
        value["patients"][0]["slot"]["note"] = "Private clinic slot note"
    tools["rerun_matching"].side_effect = lambda: deepcopy(matched)
    clinics[0].update(address="Private clinic address", phone="555-private", lat=38.731234)
    clinics[0]["slots"][0]["note"] = "Private clinic slot note"
    before = deepcopy(plan)
    clinics_before = deepcopy(clinics)
    replan, seen = install(monkeypatch, [turn(PIN, ("rerun_matching", {})), turn(("diff_plans", {})),
                                       turn(text="Wrong."), turn(text=GOOD)])
    result = replan("Adjust C02 and pin P003", plan, tools, clinics)
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
        replan("Adjust C02 and pin P003", plan, tools, clinics)
    assert caught.value is error and len(seen) == 1


def test_missing_model_id_is_clear(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [])
    monkeypatch.delenv("BEDROCK_MODEL_ID")
    with pytest.raises(ValueError, match="BEDROCK_MODEL_ID"):
        replan("Adjust C02 and pin P003", plan, tools, clinics)
    assert seen == []


def test_contract_and_exact_strict_schemas(monkeypatch, setup):
    plan, tools, _, matched, diff, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN), turn(text="Done."), turn(text=GOOD)])
    result = replan("Adjust C02 and pin P003", plan, tools, clinics)
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


def test_diff_tool_result_contains_exact_diff_and_summary_facts(monkeypatch, setup):
    plan, tools, _, _, diff, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN, ("rerun_matching", {}), ("diff_plans", {})), turn(text=GOOD)])
    replan("Adjust C02 and pin P003", plan, tools, clinics)
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
    with pytest.raises(RuntimeError if requests and requests[0][0] == "set_clinic_capacity" else ValueError):
        replan("Adjust Invented Clinic", plan, tools, clinics)
    assert len(seen) == (2 if requests else 1)
    assert [name for name, _ in calls] == [name for name, _ in requests if name in ("rerun_matching", "diff_plans")]


def test_failed_mutation_does_not_count_as_understood(monkeypatch, setup):
    plan, tools, calls, _, _, clinics = setup
    tools["set_clinic_capacity"].side_effect = ValueError("C02 holds pinned patients")
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", CAPACITY)), turn(text="Done."), turn(text=GOOD)])
    with pytest.raises(RuntimeError, match="^all tool calls failed$"):
        replan("DaVita Folsom Dialysis can only take four more", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    assert calls == []


@pytest.mark.parametrize("slot", [{"date": "2099-01-01", "shift": 1}, {"date": "2026-10-29", "shift": 4},
                                   {"date": "2026-10-27", "shift": 2, "clinic_id": "H01"}])
def test_capacity_slot_must_belong_to_supplied_clinic(monkeypatch, setup, slot):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", {**CAPACITY, **slot})),
                                       turn(PIN), turn(text="Done."), turn(text=GOOD)])
    with pytest.raises(RuntimeError, match="partial re-plan"):
        replan("Adjust C02 and pin P003", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    tools["set_clinic_capacity"].assert_not_called()


def test_assigned_clinic_omitted_from_supplied_context_is_rejected(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    clinics = [c for c in clinics if c["id"] != "C02"]
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", CAPACITY)),
                                       turn(("decline_patient", {"patient_id": "P003"})),
                                       turn(text="Done."), turn(text=GOOD)])
    with pytest.raises(RuntimeError, match="partial re-plan"):
        replan("Adjust C02 and pin P003", plan, tools, clinics)
    assert tool_results(seen[1])[0]["status"] == "error"
    tools["set_clinic_capacity"].assert_not_called()


def test_pin_rejects_hallucinated_clinic_id(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(("pin_patient", {**PIN[1], "clinic_id": "C99"})),
                                       turn(("decline_patient", {"patient_id": "P003"})),
                                       turn(text="Done."), turn(text=GOOD)])
    with pytest.raises(RuntimeError, match="partial re-plan"):
        replan("Adjust C02 and pin P003", plan, tools, clinics)
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
    with pytest.raises(RuntimeError, match="partial re-plan"):
        replan("Adjust C02 and pin P003", plan, tools, clinics)
    assert tool_results(seen[2])[-1]["status"] == "error"
    tools[name].assert_not_called()


@pytest.mark.parametrize("mutation,instruction", [
    (("decline_patient", {"patient_id": "P003"}), "Adjust C02"),
    (PIN, "Adjust C02"),
    (PIN, "Pin P0030 to C02"),
    (("set_clinic_capacity", CAPACITY), "Adjust C01"),
    (("set_clinic_capacity", CAPACITY), "Adjust C020"),
])
def test_unrequested_mutation_never_calls_tool(monkeypatch, setup, mutation, instruction):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(mutation), turn(text="Done.")])
    with pytest.raises((ValueError, RuntimeError)):
        replan(instruction, plan, tools, clinics)
    tools[mutation[0]].assert_not_called()
    error = tool_results(seen[1])[0]
    assert error["status"] == "error"
    assert "not requested" in error["content"][0]["text"]


@pytest.mark.parametrize("instruction", ["Adjust  dAvItA   FOLSOM\nDialysis", "Adjust c02 and pin p003"])
def test_scope_normalizes_matching_but_preserves_instruction(monkeypatch, setup, instruction):
    plan, tools, calls, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", CAPACITY)), turn(text="Done.")])
    replan(instruction, plan, tools, clinics)
    assert calls[0] == ("set_clinic_capacity", CAPACITY)
    payload = json.loads(seen[0]["messages"][0]["content"][0]["text"])
    assert payload["instruction"] == instruction


@pytest.mark.parametrize("chairs", [5, -1, True])
def test_capacity_cannot_exceed_original_or_be_negative_or_bool(monkeypatch, setup, chairs):
    plan, tools, _, _, _, clinics = setup
    slot = next(s for c in clinics if c["id"] == "C02" for s in c["slots"]
                if (s["date"], s["shift"]) == (CAPACITY["date"], CAPACITY["shift"]))
    slot["open_chairs"] = 4
    replan, seen = install(monkeypatch, [turn(("set_clinic_capacity", {**CAPACITY, "chairs": chairs})),
                                       turn(text="Done.")])
    with pytest.raises((ValueError, RuntimeError)):
        replan("Adjust C02 and pin P003", plan, tools, clinics)
    tools["set_clinic_capacity"].assert_not_called()
    assert tool_results(seen[1])[0]["status"] == "error"


@pytest.mark.parametrize("number", ["4", "four", "ONE", "two", "three", "five", "six", "seven", "eight", "nine", "ten"])
@pytest.mark.parametrize("all_slots", [False, True])
def test_capacity_total_includes_untouched_slots(monkeypatch, setup, number, all_slots):
    plan, tools, _, _, _, clinics = setup
    clinic = next(c for c in clinics if c["id"] == "C02")
    clinic["slots"] = [{"date": CAPACITY["date"], "shift": shift, "open_chairs": 10} for shift in (1, 2)]
    mutations = [("set_clinic_capacity", {**CAPACITY, "chairs": 10})]
    if all_slots:
        mutations.append(("set_clinic_capacity", {**CAPACITY, "shift": 2, "chairs": 1}))
    replan, _ = install(monkeypatch, [turn(*mutations), turn(text="Done.")])
    with pytest.raises(RuntimeError, match="capacity|chairs"):
        replan(f"DaVita Folsom Dialysis can only take {number} more", plan, tools, clinics)
    tools["rerun_matching"].assert_not_called()


@pytest.mark.parametrize("repair", [False, True])
def test_failed_slot_must_be_repaired_by_same_target(monkeypatch, setup, repair):
    plan, tools, _, _, _, clinics = setup
    clinic = next(c for c in clinics if c["id"] == "C02")
    clinic["slots"] = [{"date": CAPACITY["date"], "shift": i, "open_chairs": 4} for i in (1, 2)]
    attempts = 0

    def set_capacity(**args):
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise ValueError("slot holds confirmed patients")
        return {**args, "open_chairs": args["chairs"]}

    tools["set_clinic_capacity"].side_effect = set_capacity
    first = ("set_clinic_capacity", {**CAPACITY, "chairs": 2})
    second = ("set_clinic_capacity", {**CAPACITY, "shift": 2, "chairs": 1})
    script = [turn(first, ("rerun_matching", {}), ("diff_plans", {}), second)]
    if repair:
        script += [turn(("set_clinic_capacity", {**second[1], "chairs": 2}))]
    replan, seen = install(monkeypatch, [*script, turn(text="Done.")])
    if repair:
        assert replan("Adjust C02", plan, tools, clinics)["summary"] == SUMMARY
        assert tools["rerun_matching"].call_count == tools["diff_plans"].call_count == 2
    else:
        with pytest.raises(RuntimeError, match="^partial re-plan$"):
            replan("Adjust C02", plan, tools, clinics)
        assert tools["rerun_matching"].call_count == 1
    assert tool_results(seen[1])[-1]["status"] == "error"


def test_all_mutators_crashing_reports_accurate_reason(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    tools["pin_patient"].side_effect = RuntimeError("store unavailable")
    tools["decline_patient"].side_effect = RuntimeError("store unavailable")
    replan, seen = install(monkeypatch, [turn(PIN, ("decline_patient", {"patient_id": "P003"})), turn(text="Done.")])
    with pytest.raises(RuntimeError, match="^all tool calls failed$"):
        replan("Pin P003 or decline P003", plan, tools, clinics)
    assert all(r["content"] == [{"text": "Tool failed"}] for r in tool_results(seen[1]))
    tools["rerun_matching"].assert_not_called()


@pytest.mark.parametrize("elapsed", [40, 41])
def test_budget_stops_before_next_model_call(monkeypatch, setup, elapsed):
    plan, tools, _, _, _, clinics = setup
    module = importlib.import_module("lumen.ai.replan")
    clock = [100.0]
    monkeypatch.setattr(module, "monotonic", lambda: clock[0], raising=False)

    def model(number):
        if number == 1:
            clock[0] += elapsed
            return turn(PIN)
        return turn(text="Done.")

    replan, seen = install(monkeypatch, model)
    with pytest.raises(TimeoutError):
        replan("Pin P003", plan, tools, clinics)
    assert len(seen) == 1


def test_sixth_tool_turn_is_rejected_before_any_tool_execution(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [turn(PIN)] * 5 + [turn(("decline_patient", {"patient_id": "P003"}))])
    with pytest.raises(RuntimeError, match="6|six"):
        replan("Pin or decline P003", plan, tools, clinics)
    assert len(seen) == 6
    assert tools["pin_patient"].call_count == 5
    tools["decline_patient"].assert_not_called()


@pytest.mark.parametrize("error", [ValueError("Private Patient, Private Address, 555-private"),
    ValueError("x" * 200), RuntimeError("database unavailable")])
def test_tool_warning_and_error_text_are_sanitized(monkeypatch, setup, caplog, error):
    plan, tools, _, _, _, clinics = setup
    tools["pin_patient"].side_effect = error
    replan, seen = install(monkeypatch, [turn(PIN), turn(text="Done.")])
    with pytest.raises(RuntimeError, match="all tool calls failed"):
        replan("Pin P003", plan, tools, clinics)
    assert tool_results(seen[1])[0]["content"] == [{"text": "Tool failed"}]
    assert str(error) not in json.dumps(seen) and str(error) not in caplog.text
    assert any(r.levelname == "WARNING" and r.message == f"Replan tool failed: {type(error).__name__}" and r.exc_info is None
               for r in caplog.records)


def test_adapter_retry_checks_same_deadline(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    module = importlib.import_module("lumen.ai.replan")
    clock = [100.0]
    monkeypatch.setattr(module, "monotonic", lambda: clock[0])
    transient = ClientError({"Error": {"Code": "ThrottlingException", "Message": "throttled"}}, "Converse")
    client = Mock()

    def call(**kwargs):
        clock[0] = 140.0
        raise transient

    client.converse.side_effect = call
    monkeypatch.setattr(module.bedrock, "_get_client", lambda: client)
    monkeypatch.setattr(module.bedrock, "sleep", lambda _: None)
    with pytest.raises(TimeoutError):
        module.replan("Pin P003", plan, tools, clinics)
    assert client.converse.call_count == 1


def test_late_final_response_cannot_return_a_plan(monkeypatch, setup):
    plan, tools, _, _, _, clinics = setup
    module = importlib.import_module("lumen.ai.replan")
    clock = [100.0]
    monkeypatch.setattr(module, "monotonic", lambda: clock[0])

    def model(number):
        if number == 1:
            return turn(PIN)
        clock[0] = 140.0
        return turn(text="Done.")

    replan, _ = install(monkeypatch, model)
    with pytest.raises(TimeoutError):
        replan("Pin P003", plan, tools, clinics)
    tools["rerun_matching"].assert_not_called()


@pytest.mark.parametrize("action,words", [("early_session", "has an earlier treatment"),
    ("transfer", "transfers to another clinic"), ("hospital", "needs a staff call"),
    ("notify_only", "receives a notification")])
def test_summary_uses_plain_actions_and_clinics_of_changed_rows(monkeypatch, setup, action, words):
    plan, tools, _, _, _, clinics = setup
    tools["diff_plans"].side_effect = lambda: [
        {"patient_id": "P003", "field": "pinned", "from": False, "to": True},
        {"patient_id": "P003", "field": "action", "from": None, "to": action},
    ]
    replan, _ = install(monkeypatch, [turn(PIN), turn(text="P999 is changed.")])
    summary = replan("Pin P003", plan, tools, clinics)["summary"]
    assert summary == f"1 patient row changed at DaVita Folsom Dialysis. New actions: 1 patient {words}; 1 patient pinned."
    assert "P999" not in summary and "Cameron" not in summary


@pytest.mark.parametrize("tool_name", ["rerun_matching", "diff_plans"])
def test_finalization_tool_failures_are_logged_and_propagate(monkeypatch, setup, caplog, tool_name):
    plan, tools, _, _, _, clinics = setup
    error = RuntimeError("store unavailable")
    tools[tool_name].side_effect = error
    replan, _ = install(monkeypatch, [turn(PIN), turn(text="Done.")])
    with pytest.raises(RuntimeError) as caught:
        replan("Pin P003", plan, tools, clinics)
    assert str(caught.value) == "Tool failed"
    assert any(r.levelname == "WARNING" and r.message == "Replan tool failed: RuntimeError"
               and r.exc_info is None for r in caplog.records)


@pytest.mark.parametrize("slow_tool,next_tool", [("pin_patient", "decline_patient"), ("rerun_matching", "diff_plans")])
def test_expired_tool_budget_stops_remaining_work(monkeypatch, setup, slow_tool, next_tool):
    plan, tools, _, _, _, clinics = setup
    module = importlib.import_module("lumen.ai.replan")
    clock = [100.0]
    monkeypatch.setattr(module, "monotonic", lambda: clock[0])
    original = tools[slow_tool].side_effect

    def slow(**args):
        clock[0] = 140.0
        return original(**args)

    tools[slow_tool].side_effect = slow
    batch = [PIN, ("decline_patient", {"patient_id": "P003"})] if slow_tool == "pin_patient" else [PIN]
    replan, _ = install(monkeypatch, [turn(*batch), turn(text="Done.")])
    with pytest.raises(TimeoutError):
        replan("Pin or decline P003", plan, tools, clinics)
    tools[next_tool].assert_not_called()


@pytest.mark.parametrize("instruction", [
    "C02 no more", "C02 zero more", "C02 can only take no more", "C02 can only take zero more", "C02 can't take any more",
    "C02 can now only take 4 more", "Only 4 more at C02", "C01 and C02 can only take 2 more",
    *[f"C02 can only take {n} more" for n in "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()],
])
def test_review_limits_never_drop_a_cap(monkeypatch, setup, instruction):
    # Port of adversarial test 1: keeping the existing chairs must not succeed.
    plan, tools, _, _, _, clinics = setup
    clinics[1]["slots"] = [{**CAPACITY, "open_chairs": 25}]
    chairs = 25
    if instruction.startswith("C01 and"):
        clinics[0]["slots"][0]["open_chairs"] = 25
        chairs = 2
    replan, _ = install(monkeypatch, [turn(("set_clinic_capacity", {**CAPACITY, "chairs": chairs})), turn()])
    with pytest.raises(RuntimeError, match="capacity"):
        replan(instruction, plan, tools, clinics)
    zeros = [("set_clinic_capacity", {"clinic_id": c["id"], "date": s["date"], "shift": s["shift"], "chairs": 0})
             for c in clinics[:2] if c["id"] == "C02" or instruction.startswith("C01 and") for s in c["slots"]]
    replan, _ = install(monkeypatch, [turn(*zeros), turn()])
    assert replan(instruction, plan, tools, clinics)["plan"]


@pytest.mark.parametrize("instruction", ["C02 can only take a few more", "Only twenty-one more at C02", "C02 can only take 1.5 more", "C02 no more than 3"])
def test_review_unparsed_limit_fails_closed(monkeypatch, setup, instruction):
    plan, tools, _, _, _, clinics = setup
    replan, seen = install(monkeypatch, [])
    with pytest.raises(ValueError, match="limit"):
        replan(instruction, plan, tools, clinics)
    assert not seen


@pytest.mark.parametrize("instruction,patient,allowed", [
    ("Leave P001 alone; C02 can only take 4 more", "P001", False),
    ("Do not touch P100", "P100", False), ("P001 is waiting", "P001", False),
    ("Do not decline P001", "P001", False), ("Decline a different patient after reviewing P001", "P001", False), ("Pin P002; leave P001 alone", "P001", False),
    ("P001 didn't decline the chair", "P001", False), ("P001 hasn't declined", "P001", False),
    ("Keep P001 away from C02 at all costs", "P001", False),
    ("P001 declined the new chair", "P001", True), ("Drop p001-p002", "P002", True),
    ("Decline P001's chair", "P001", True), ("Decline P1", "P001", False),
])
def test_review_patient_action_scope(monkeypatch, setup, instruction, patient, allowed):
    # Ports adversarial test 2 and preserves ID range/possessive boundaries.
    plan, tools, _, _, _, clinics = setup
    plan["patients"] += [{**plan["patients"][0], "patient_id": "P100"}]
    replan, seen = install(monkeypatch, [turn(("decline_patient", {"patient_id": patient})), turn()])
    if allowed:
        replan(instruction, plan, tools, clinics)
    else:
        with pytest.raises(RuntimeError, match="all tool calls failed"):
            replan(instruction, plan, tools, clinics)
        tools["decline_patient"].assert_not_called()
        assert "not requested" in str(tool_results(seen[1]))


@pytest.mark.parametrize("separate", [False, True])
def test_review_nested_clinic_names(monkeypatch, setup, separate):
    plan, tools, _, _, _, clinics = setup
    clinics[0]["name"], clinics[1]["name"] = "Folsom Dialysis", "North Folsom Dialysis"
    args = {"clinic_id": "C01", "date": "2026-10-27", "shift": 1, "chairs": 0}
    replan, _ = install(monkeypatch, [turn(("set_clinic_capacity", args)), turn()])
    instruction = "Adjust North Folsom Dialysis" + ("; adjust Folsom Dialysis" if separate else "")
    if separate:
        replan(instruction, plan, tools, clinics)
    else:
        with pytest.raises(RuntimeError, match="all tool calls failed"):
            replan(instruction, plan, tools, clinics)
        tools["set_clinic_capacity"].assert_not_called()


@pytest.mark.parametrize("case,expected", [
    ("decline", ["1 patient declined", "1 patient needs a staff call"]),
    ("pin", ["1 pinned move", "1 pickup change"]),
    ("capacity", ["DaVita Folsom Dialysis", "nobody moved"]),
    ("unknown", ["1 patient has an updated action"]),
])
def test_review_summary_reports_operational_changes(monkeypatch, setup, case, expected):
    # Adversarial test 3: a declined chair and new staff-call flag must be visible.
    plan, tools, _, matched, _, clinics = setup
    changes = {"decline": [("status", "draft", "declined"), ("flags", [], ["staff_call"]), ("slot", {}, None)],
               "pin": [("pinned", False, True), ("clinic_id", "C01", "C02"), ("pickup_time", None, "10:00")],
               "capacity": [], "unknown": [("action", "transfer", "future_action")]}
    tools["diff_plans"].side_effect = lambda: [{"patient_id": "P003", "field": f, "from": a, "to": b}
                                             for f, a, b in changes[case]]
    mutation = ("decline_patient", {"patient_id": "P003"}) if case == "decline" else PIN
    requests = ([] if case == "capacity" else [mutation]) + [("set_clinic_capacity", {**CAPACITY, "chairs": 0})]
    replan, _ = install(monkeypatch, [turn(*requests), turn()])
    summary = replan("P003 declined the chair; adjust C02" if case == "decline" else "Pin P003 and adjust C02", plan, tools, clinics)["summary"]
    assert all(value in summary for value in expected)
    assert summary.count(".") == 2


@pytest.mark.parametrize("instruction", ["Move P003 to C02", "Send P003 to C02", "Keep P003 at C02"])
def test_review_positive_pin_actions(monkeypatch, setup, instruction):
    plan, tools, _, _, _, clinics = setup
    replan, _ = install(monkeypatch, [turn(PIN), turn()])
    replan(instruction, plan, tools, clinics)
    tools["pin_patient"].assert_called_once()
