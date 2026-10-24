"""Plain sentences for plan-check issues (POST /check). Code decides every issue; the model only rewords them."""

import json

from lumen.ai import bedrock

MAX_WORDS = 30
SOFT_CODES = ("heart_failure_long_gap", "lives_alone_night_pickup", "wheelchair_long_drive", "language_unconfirmed")
PROMPT = """You help dialysis clinic staff read a plan check.
You get a list of issues and the facts for each moved patient.
For each issue, write one plain sentence of 30 words or fewer for clinic staff.
Use only the facts in that issue and in the patient's row. Do not add facts, numbers, names, causes or advice.
Do not change how serious an issue is. Do not say that an issue is fixed, safe or not a problem.
Then list soft warnings. Use only these codes:
- heart_failure_long_gap: heart_failure is true and long_gap_after is true.
- lives_alone_night_pickup: lives_alone is true and pickup is before 06:00 or at 19:00 or later.
- wheelchair_long_drive: mobility is wheelchair and drive_minutes is more than 30.
- language_unconfirmed: language is not en and action is transfer or hospital.
Add a soft warning only when the row facts show it.
Call the tool explain one time."""
TOOLS = [{"toolSpec": {
    "name": "explain",
    "description": "One plain sentence per issue, by issue index, and soft warnings from the fixed list.",
    "inputSchema": {"json": {
        "type": "object", "additionalProperties": False, "required": ["items", "soft"],
        "properties": {
            "items": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["index", "text"],
                "properties": {"index": {"type": "integer", "minimum": 0}, "text": {"type": "string"}}}},
            "soft": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["patient_id", "code"],
                "properties": {"patient_id": {"type": "string", "pattern": r"^P\d{3}$"},
                               "code": {"type": "string", "enum": list(SOFT_CODES)}}}},
        },
    }},
}}]


def explain_issues(issues, facts, model_id):
    """{"items": [{index, text}], "soft": [{patient_id, code}]}. Drops every sentence that is empty, over 30 words or
    for an unknown index, and every soft warning with an unknown code. Bedrock errors propagate."""
    if not model_id:
        raise ValueError("BEDROCK_MODEL_FAST is required for the plan check")
    payload = {"issues": [{"index": i, **{k: issue[k] for k in ("patient_id", "facility_id", "severity", "code", "text")}}
                          for i, issue in enumerate(issues)], "rows": facts}
    reply = bedrock.converse(model_id, PROMPT, [{"role": "user", "content": [{"text": json.dumps(payload)}]}],
                             tools=TOOLS, tool_choice="explain")
    uses = reply["tool_uses"]
    if len(uses) != 1 or uses[0]["name"] != "explain" or not isinstance(uses[0]["input"], dict):
        raise ValueError("the model must call explain once")
    out = uses[0]["input"]
    texts = {}
    for item in out.get("items") or []:
        if not isinstance(item, dict) or type(item.get("index")) is not int or not isinstance(item.get("text"), str):
            continue
        text = " ".join(item["text"].split())
        if 0 <= item["index"] < len(issues) and text and len(text.split()) <= MAX_WORDS:
            texts.setdefault(item["index"], text)
    soft = [{"patient_id": s["patient_id"], "code": s["code"]} for s in out.get("soft") or []
            if isinstance(s, dict) and isinstance(s.get("patient_id"), str) and s.get("code") in SOFT_CODES]
    return {"items": [{"index": i, "text": t} for i, t in sorted(texts.items())], "soft": soft}
