"""Re-plan instructions in plain words (POST /replan, step intent). The model only reads the instruction into at most 3
changes; code checks each change and applies it (replan_tools.apply_changes). The model never sees patient names."""

import json
import re
import unicodedata
from collections import Counter

from lumen.ai import bedrock

MAX_CHANGES = 3
KINDS = {"clinic_limit": ("clinic_id", "more"), "decline": ("patient_id",), "pin": ("patient_id", "clinic_id", "date", "shift")}
ROW_FIELDS = ("patient_id", "action", "clinic_id", "slot", "status")
PROMPT = """You help dialysis clinic staff change a treatment plan during a power shutoff.
You get one instruction from staff, the dialysis clinics with their open chairs, and the plan rows.
Patients appear only as IDs, for example P012.
Turn the instruction into 1 to 3 changes. Use only these kinds:
- clinic_limit: the clinic takes at most "more" visiting patients. Example: "DaVita Folsom can only take 4 more".
- decline: the patient will not come. Example: "P012 declined".
- pin: the patient goes to the clinic on the date and shift. Use a date and shift from that clinic's slots.
Use only clinic IDs and patient IDs from the input. Do not add a change that the instruction does not ask for.
Call the tool change one time."""
TOOLS = [{"toolSpec": {
    "name": "change",
    "description": "The changes that the instruction asks for, at most 3.",
    "inputSchema": {"json": {
        "type": "object", "additionalProperties": False, "required": ["changes"],
        "properties": {"changes": {"type": "array", "minItems": 1, "maxItems": MAX_CHANGES, "items": {
            "type": "object", "additionalProperties": False, "required": ["kind"],
            "properties": {"kind": {"type": "string", "enum": list(KINDS)},
                           "clinic_id": {"type": "string", "pattern": r"^C\d{2}$"},
                           "patient_id": {"type": "string", "pattern": r"^P\d{3}$"},
                           "more": {"type": "integer", "minimum": 0},
                           "date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                           "shift": {"type": "integer", "minimum": 1, "maximum": 4}}}}},
    }},
}}]


def _words(text):
    return rf"(?<!\w){r'\s+'.join(map(re.escape, text.split()))}(?!\w)"


def _plain(text):
    """text without accents: staff often type Rios for Ríos."""
    return unicodedata.normalize("NFC", "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c)))


def hide_names(text, patients, clinics):
    """The instruction, without accents, with each patient name replaced by the patient ID: the full name, and a first or
    last name that exactly one patient has. Case and accents do not matter. Two words of a clinic name stay ("Cameron Park")."""
    text = _plain(text)
    for p in sorted(patients, key=lambda p: -len(p["name"])):
        text = re.sub(_words(_plain(p["name"])), p["id"], text, flags=re.IGNORECASE)
    count = Counter(w for p in patients for w in {_plain(w).casefold() for w in p["name"].split()})
    one = {_plain(w).casefold(): p["id"] for p in patients for w in p["name"].split() if count[_plain(w).casefold()] == 1}
    if not one:
        return text
    kept = [m.span() for c in clinics for pair in zip(c["name"].split(), c["name"].split()[1:])
            for m in re.finditer(_words(" ".join(pair)), text, flags=re.IGNORECASE)]
    parts = re.compile(rf"(?<!\w)(?:{'|'.join(map(re.escape, sorted(one, key=len, reverse=True)))})(?!\w)", re.IGNORECASE)
    return parts.sub(lambda m: m[0] if any(a <= m.start() < b for a, b in kept) else one[m[0].casefold()], text)


def check_change(change, patient_ids, clinic_ids):
    """The change with only its own keys; other keys are dropped (an emulated tool call may fill them with null).
    ValueError on a bad kind, a missing key, an unknown ID, a bad date or shift, or more below 0."""
    keys = KINDS.get(change.get("kind")) if isinstance(change, dict) else None
    if keys is None or not set(keys) <= set(change):
        raise ValueError("each change needs a known kind and its keys")
    valid = {"clinic_id": lambda v: isinstance(v, str) and v in clinic_ids,
             "patient_id": lambda v: isinstance(v, str) and v in patient_ids,
             "more": lambda v: type(v) is int and v >= 0,
             "date": lambda v: isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v) is not None,
             "shift": lambda v: type(v) is int and 1 <= v <= 4}
    bad = [k for k in keys if not valid[k](change[k])]
    if bad:
        raise ValueError(f"bad {', '.join(bad)} in a {change['kind']} change")
    return {"kind": change["kind"], **{k: change[k] for k in keys}}


def read_changes(instruction, plan, clinics, patients, model_id):
    """1 to 3 checked changes for the instruction. ValueError when the reply breaks a rule, so the router tries the rules.
    Bedrock errors propagate."""
    if not model_id:
        raise ValueError("BEDROCK_MODEL_FAST is required for the re-plan intent step")
    dialysis = [c for c in clinics if c["kind"] == "dialysis"]
    payload = {"instruction": hide_names(instruction, patients, clinics),
               "clinics": [{**{k: c[k] for k in ("id", "name", "home")},
                            "slots": [{k: s[k] for k in ("date", "shift", "open_chairs")} for s in c["slots"]]} for c in dialysis],
               "patients": [{k: r[k] for k in ROW_FIELDS} for r in plan["patients"]]}
    reply = bedrock.converse(model_id, PROMPT, [{"role": "user", "content": [{"text": json.dumps(payload)}]}],
                             tools=TOOLS, tool_choice="change")
    uses = reply["tool_uses"]
    if len(uses) != 1 or uses[0]["name"] != "change" or not isinstance(uses[0]["input"], dict):
        raise ValueError("the model must call change once")
    changes = uses[0]["input"].get("changes")
    if not isinstance(changes, list) or not 1 <= len(changes) <= MAX_CHANGES:
        raise ValueError(f"the model must give 1 to {MAX_CHANGES} changes")
    ids = {r["patient_id"] for r in plan["patients"]}
    return [check_change(c, ids, {c["id"] for c in dialysis}) for c in changes]
