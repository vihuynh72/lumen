"""Bounded orchestration over injected tools; Backend owns every plan edit."""

from collections import Counter
from dataclasses import dataclass, field, replace
import json
import logging
import os
from pathlib import Path
import re
from time import monotonic

from botocore.exceptions import BotoCoreError, ClientError

from lumen.ai import bedrock


PROMPT = Path(__file__).with_name("prompts").joinpath("replan.md").read_text()
logger = logging.getLogger(__name__)
ROW_FIELDS = ("patient_id", "rank", "action", "clinic_id", "slot", "status", "pinned")
MUTATORS = frozenset(("set_clinic_capacity", "pin_patient", "decline_patient"))
PARAMETERS = {
    "patient_id": {"type": "string", "pattern": r"^P\d{3}$"},
    "clinic_id": {"type": "string", "pattern": r"^[CH]\d{2}$"},
    "date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
    "shift": {"type": "integer", "minimum": 1, "maximum": 4},
    "chairs": {"type": "integer", "minimum": 0},
}
ARGUMENTS = {
    "set_clinic_capacity": ("clinic_id", "date", "shift", "chairs"),
    "pin_patient": ("patient_id", "clinic_id", "date", "shift"),
    "decline_patient": ("patient_id",), "rerun_matching": (), "diff_plans": (),
}
DESCRIPTIONS = {
    "set_clinic_capacity": "Set total visiting chairs for one clinic slot.",
    "pin_patient": "Pin a patient to a clinic slot.",
    "decline_patient": "Mark a patient declined.",
    "rerun_matching": "Recompute patients and overflow after edits.",
    "diff_plans": "Return changed fields against the original plan.",
}
TOOL_SCHEMAS = [{"toolSpec": {
    "name": name, "description": DESCRIPTIONS[name],
    "inputSchema": {"json": {"type": "object", "additionalProperties": False,
                             "properties": {key: PARAMETERS[key] for key in args},
                             "required": list(args)}},
}} for name, args in ARGUMENTS.items()]


@dataclass(frozen=True)
class _State:
    patients: frozenset
    clinics: frozenset
    slots: dict
    requested_clinics: frozenset
    requested_patients: frozenset
    limits: dict
    capacities: dict = field(default_factory=dict)
    attempted: bool = False
    failures: frozenset = frozenset()
    mutated: bool = False
    matched: dict | None = None
    diff: list | None = None


def _rows(plan):
    """Never forward patient names, prose, audio, or home coordinates."""
    return [{key: row[key] for key in ROW_FIELDS if key in row} for row in plan["patients"]]


def _clinic_context(clinics):
    """Only public identity and capacity facts, never contact details."""
    return [{**{key: clinic[key] for key in ("id", "name", "kind", "home")},
             "slots": [{key: slot[key] for key in ("date", "shift", "open_chairs")}
                       for slot in clinic["slots"]]} for clinic in clinics]


def _mentions(text, value):
    return re.search(rf"(?<!\w){re.escape(' '.join(value.casefold().split()))}(?!\w)", text)


def _limits(text, clinics):
    numbers = dict(zip("one two three four five six seven eight nine ten".split(), range(1, 11)))
    limits = {}
    for match in re.finditer(r"\bcan only take (\d+|" + "|".join(numbers) + r") more\b", text):
        prefix = text[:match.start()].rstrip(" ():,")
        hits = {c["id"] for c in clinics for alias in (c["id"], c["name"])
                if re.search(rf"(?<!\w){re.escape(' '.join(alias.casefold().split()))}$", prefix)}
        if len(hits) != 1:
            raise ValueError("instruction not understood")
        cid = next(iter(hits))
        number = match[1]
        limit = int(number) if number.isdigit() else numbers[number]
        limits = {**limits, cid: min(limits.get(cid, limit), limit)}
    return limits


def _known(plan, clinics, instruction):
    text = " ".join(instruction.casefold().split())
    return _State(frozenset(r["patient_id"] for r in plan["patients"]),
                  frozenset(c["id"] for c in clinics),
                  {(c["id"], s["date"], s["shift"]): s["open_chairs"] for c in clinics for s in c["slots"]},
                  frozenset(c["id"] for c in clinics if _mentions(text, c["id"]) or _mentions(text, c["name"])),
                  frozenset(r["patient_id"] for r in plan["patients"] if _mentions(text, r["patient_id"])),
                  _limits(text, clinics))


def _validate(name, args, state):
    if name not in ARGUMENTS:
        raise ValueError("Unknown tool")
    if not isinstance(args, dict) or set(args) != set(ARGUMENTS[name]):
        raise ValueError("Tool arguments must match its required keys exactly")
    for key, value in args.items():
        schema = PARAMETERS[key]
        if schema["type"] == "integer":
            if type(value) is not int or value < schema["minimum"] or value > schema.get("maximum", value):
                raise ValueError(f"Invalid {key}")
        elif not isinstance(value, str) or not re.fullmatch(schema["pattern"], value):
            raise ValueError(f"Invalid {key}")
    if "patient_id" in args and args["patient_id"] not in state.patients:
        raise ValueError("Patient ID is not in the supplied plan")
    if "clinic_id" in args and args["clinic_id"] not in state.clinics:
        raise ValueError("Clinic ID is not in the supplied clinics")
    if name == "set_clinic_capacity" and (args["clinic_id"], args["date"], args["shift"]) not in state.slots:
        raise ValueError("Slot is not in the supplied clinic")
    if name == "set_clinic_capacity" and args["clinic_id"] not in state.requested_clinics:
        raise ValueError("Clinic capacity change was not requested")
    if name in ("pin_patient", "decline_patient") and args["patient_id"] not in state.requested_patients:
        raise ValueError("Patient change was not requested")
    if name == "set_clinic_capacity" and args["chairs"] > state.slots[(args["clinic_id"], args["date"], args["shift"])]:
        raise ValueError("Chairs exceed the slot's original open chairs")


def _facts(diff):
    """Count distinct rows, not changed fields; only new actions are counted."""
    actions = Counter(d["to"] for d in diff if d["field"] == "action")
    clinics = sorted({value for d in diff if d["field"] == "clinic_id"
                      for value in (d["from"], d["to"]) if value})
    return {"changed_rows": len({d["patient_id"] for d in diff}),
            "clinics": clinics, "new_actions": dict(sorted(actions.items()))}


def _summary(diff, clinics, old_plan, new_plan):
    facts = _facts(diff)
    names = {c["id"]: c["name"] for c in clinics}
    changed = {d["patient_id"] for d in diff}
    involved = set(facts["clinics"]) | {r["clinic_id"] for p in (old_plan, new_plan)
                                        for r in p["patients"] if r["patient_id"] in changed and r.get("clinic_id")}
    places = ", ".join(names.get(cid, cid) for cid in sorted(involved)) or "the existing clinics"
    count = facts["changed_rows"]
    descriptions = {
        "early_session": ("has an earlier treatment", "have earlier treatments"),
        "transfer": ("transfers to another clinic", "transfer to other clinics"),
        "hospital": ("needs a staff call", "need staff calls"),
        "notify_only": ("receives a notification", "receive notifications"),
    }
    actions = "; ".join(
        f"{n} patient{'' if n == 1 else 's'} {descriptions[action][n != 1]}"
        for action, n in facts["new_actions"].items()
    )
    return (f"{count} patient row{'' if count == 1 else 's'} changed at {places}. "
            f"New actions: {actions or '0 action changes'}.")


def _view(name, value, state):
    if name == "rerun_matching":
        return {"patients": _rows(value), "overflow": value["overflow"]}
    if name == "diff_plans":
        # The contract's diff excludes names and text fields.
        return {"diff": value, "summary_facts": _facts(value), "matching_current": state.matched is not None}
    keys = ("patient_id", "clinic_id", "date", "shift", "open_chairs", "action", "slot", "pinned", "status")
    return {key: value[key] for key in keys if key in value}


def _updated(state, name, value):
    if name == "rerun_matching":
        return replace(state, matched=value, diff=None)
    if name == "diff_plans":
        return replace(state, diff=value if state.matched is not None else None)
    return replace(state, mutated=True) if name in MUTATORS else state


def _call_tool(tools, name, args):
    try:
        return tools[name](**args)
    except Exception as exc:
        logger.warning("Replan tool %s failed: %s: %s", name, type(exc).__name__, exc)
        raise


def _execute(use, tools, state):
    name, args = use["name"], use["input"]
    key = None
    if name in MUTATORS:
        fields = ("clinic_id", "date", "shift") if name == "set_clinic_capacity" else ("patient_id",)
        target = [args.get(k) for k in fields] if isinstance(args, dict) else args
        key = (name, json.dumps(target, sort_keys=True))
        state = replace(state, attempted=True)
    try:
        _validate(name, args, state)
        # A tool may change its working copy before raising: invalidate first.
        if name in MUTATORS or name == "rerun_matching":
            state = replace(state, matched=None, diff=None)
        value = _call_tool(tools, name, args)
    except (BotoCoreError, ClientError):
        raise
    except ValueError as exc:
        content, status = [{"text": str(exc) if len(str(exc)) < 200 else "Tool failed"}], "error"
    except Exception:
        content, status = [{"text": "Tool failed"}], "error"
    else:
        state = _updated(state, name, value)
        if name == "set_clinic_capacity":
            slot_key = (args["clinic_id"], args["date"], args["shift"])
            state = replace(state, capacities={**state.capacities, slot_key: args["chairs"]})
        content, status = [{"json": _view(name, value, state)}], "success"
    if key is not None:
        failures = state.failures | {key} if status == "error" else state.failures - {key}
        state = replace(state, failures=frozenset(failures))
    return state, {"toolResult": {"toolUseId": use["id"], "content": content, "status": status}}


def _finish(state, tools, check_budget):
    if state.attempted and not state.mutated:
        raise RuntimeError("all tool calls failed")
    if state.failures:
        raise RuntimeError("partial re-plan")
    if not state.mutated:
        raise ValueError("instruction not understood")
    for cid, limit in state.limits.items():
        total = sum(state.capacities.get(key, chairs) for key, chairs in state.slots.items() if key[0] == cid)
        if total > limit:
            raise RuntimeError("Clinic capacity exceeds the requested total chairs")
    if state.matched is None:
        check_budget()
        state = _updated(state, "rerun_matching", _call_tool(tools, "rerun_matching", {}))
    if state.diff is None:
        check_budget()
        state = replace(state, diff=_call_tool(tools, "diff_plans", {}))
    check_budget()
    return state


def replan(instruction: str, plan: dict, tools: dict, clinics: list | None = None) -> dict:
    """Return tool-owned results; the router falls back until it passes clinics."""
    if clinics is None:
        raise ValueError("clinic context missing")
    deadline = monotonic() + 40

    def check_budget():
        if monotonic() >= deadline:
            raise TimeoutError("Replan exceeded its 40 second budget")

    model_id = os.getenv("BEDROCK_MODEL_ID", "").strip()
    if not model_id:
        raise ValueError("BEDROCK_MODEL_ID is required for replan")
    clinics = _clinic_context(clinics)
    state = _known(plan, clinics, instruction)
    messages = [{"role": "user", "content": [{"text": json.dumps({
        "instruction": instruction, "patients": _rows(plan), "clinics": clinics,
    })}]}]
    calls = 0
    while True:
        check_budget()
        with bedrock.attempt_guard(check_budget):
            result = bedrock.converse(model_id, PROMPT, messages, tools=TOOL_SCHEMAS, tool_choice=None)
        check_budget()
        calls += 1
        messages = [*messages, result["message"]]
        if result["stop_reason"] == "tool_use":
            if calls >= 6:
                raise RuntimeError("Replan still requested tools after 6 model calls")
            blocks = []
            for use in result["tool_uses"]:
                check_budget()
                state, block = _execute(use, tools, state)
                blocks = [*blocks, block]
            messages = [*messages, {"role": "user", "content": blocks}]
            continue
        if result["stop_reason"] != "end_turn":
            raise RuntimeError("Replan model did not finish its turn")
        state = _finish(state, tools, check_budget)
        return {"plan": state.matched, "diff": state.diff,
                "summary": _summary(state.diff, clinics, plan, state.matched)}
