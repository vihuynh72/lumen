"""Bounded orchestration over injected tools; Backend owns every plan edit."""

from collections import Counter
from dataclasses import dataclass, replace
import json
import os
from pathlib import Path
import re

from botocore.exceptions import BotoCoreError, ClientError

from lumen.ai import bedrock


PROMPT = Path(__file__).with_name("prompts").joinpath("replan.md").read_text()
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
    matched: dict | None = None
    diff: list | None = None


def _rows(plan):
    """Never forward patient names, prose, audio, or home coordinates."""
    return [{key: row[key] for key in ROW_FIELDS if key in row} for row in plan["patients"]]


def _known(plan):
    return _State(frozenset(r["patient_id"] for r in plan["patients"]),
                  frozenset(r["clinic_id"] for r in plan["patients"] if r.get("clinic_id")))


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
        raise ValueError("Patient ID has not been seen in the plan or tool results")
    if "clinic_id" in args and args["clinic_id"] not in state.clinics:
        raise ValueError("Clinic ID has not been seen in the plan or tool results")


def _facts(diff):
    """Count distinct rows, not changed fields; only new actions are counted."""
    actions = Counter(d["to"] for d in diff if d["field"] == "action")
    clinics = sorted({value for d in diff if d["field"] == "clinic_id"
                      for value in (d["from"], d["to"]) if value})
    return {"changed_rows": len({d["patient_id"] for d in diff}),
            "clinics": clinics, "new_actions": dict(sorted(actions.items()))}


def _template(facts):
    count = facts["changed_rows"]
    places = ", ".join(facts["clinics"]) or "the existing clinics"
    actions = ", ".join(f"{count} {action}" for action, count in facts["new_actions"].items())
    return (f"{count} patient row{'' if count == 1 else 's'} changed at {places}. "
            f"New actions: {actions or '0 action changes'}.")


def _valid_summary(text, facts):
    sentences = re.findall(r"[^.!?]+[.!?]", text.strip())
    if len(sentences) != 2 or "".join(sentences).strip() != text.strip():
        return False
    numbers = lambda s: [int(n) for n in re.findall(r"(?<![\w.])[+-]?\d+(?![\w.])", s)]
    expected = list(facts["new_actions"].values()) or [0]
    return (numbers(sentences[0]) == [facts["changed_rows"]]
            and numbers(sentences[1]) == expected
            and set(re.findall(r"\b[CH]\d+\b", text)) == set(facts["clinics"])
            and all(re.search(rf"\b{re.escape(clinic)}\b", sentences[0]) for clinic in facts["clinics"])
            and all(re.search(rf"\b{count}\s+{re.escape(action)}\b", sentences[1])
                    for action, count in facts["new_actions"].items()))


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
        known = _known(value)
        return replace(state, matched=value, diff=None,
                       patients=state.patients | known.patients, clinics=state.clinics | known.clinics)
    if name == "diff_plans":
        return replace(state, diff=value if state.matched is not None else None)
    return state


def _execute(use, tools, state):
    name, args = use["name"], use["input"]
    try:
        _validate(name, args, state)
        # A tool may change its working copy before raising: invalidate first.
        if name in MUTATORS or name == "rerun_matching":
            state = replace(state, matched=None, diff=None)
        value = tools[name](**args)
    except (BotoCoreError, ClientError):
        raise
    except ValueError as exc:
        content, status = [{"text": str(exc)}], "error"
    except Exception:
        content, status = [{"text": "Tool failed"}], "error"
    else:
        state = _updated(state, name, value)
        content, status = [{"json": _view(name, value, state)}], "success"
    return state, {"toolResult": {"toolUseId": use["id"], "content": content, "status": status}}


def _finish(state, tools):
    if state.matched is None:
        state = _updated(state, "rerun_matching", tools["rerun_matching"]())
    if state.diff is None:
        state = replace(state, diff=tools["diff_plans"]())
    return state


def _summary_request(facts, retry=False):
    return {"role": "user", "content": [{"text": json.dumps({
        "summary_facts": facts,
        "request": ("Correct the summary. " if retry else "") +
                   "Write exactly two sentences using only these facts. First give changed_rows and clinics; "
                   "second give new_actions in the supplied order (0 action changes if empty). "
                   "Use digits for counts and the exact action labels. Do not call tools.",
    })}]}


def replan(instruction, plan, tools):
    """Return only tool-owned plan/diff and a checked two-sentence summary."""
    model_id = os.getenv("BEDROCK_MODEL_ID", "").strip()
    if not model_id:
        raise ValueError("BEDROCK_MODEL_ID is required for replan")
    state = _known(plan)
    messages = [{"role": "user", "content": [{"text": json.dumps({
        "instruction": instruction, "patients": _rows(plan),
    })}]}]
    calls, summary_attempts = 0, 0
    while True:
        result = bedrock.converse(model_id, PROMPT, messages, tools=TOOL_SCHEMAS, tool_choice=None)
        calls += 1
        messages = [*messages, result["message"]]
        if result["stop_reason"] == "tool_use":
            blocks = []
            for use in result["tool_uses"]:
                state, block = _execute(use, tools, state)
                blocks = [*blocks, block]
            if calls >= 6:
                raise RuntimeError("Replan still requested tools after 6 model calls")
            messages = [*messages, {"role": "user", "content": blocks}]
            summary_attempts = 0
            continue
        if result["stop_reason"] != "end_turn":
            raise RuntimeError("Replan model did not finish its turn")
        if "REPLAN_CONTEXT_UNAVAILABLE" in result["text"]:
            raise RuntimeError("Replan needs clinic or slot context; use the router fallback")
        had_facts = state.matched is not None and state.diff is not None
        state = _finish(state, tools)
        facts = _facts(state.diff)
        if had_facts:
            summary_attempts += 1
            if _valid_summary(result["text"], facts):
                return {"plan": state.matched, "diff": state.diff, "summary": result["text"].strip()}
        if summary_attempts >= 2 or calls >= 6:
            return {"plan": state.matched, "diff": state.diff, "summary": _template(facts)}
        messages = [*messages, _summary_request(facts, retry=had_facts)]
