"""Generate plan text from a small, name-free set of preformatted facts."""

from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path

from lumen.ai import bedrock


MOVES = ("early_session", "transfer")
TIMES = {1: "06:00", 2: "10:30", 3: "15:00", 4: "19:30"}
REASONS = {
    "session_in_window": "session during shutoff", "session_within_36h": "session within 36 hours",
    "heart_failure": "heart failure", "missed_recently": "recent missed session",
    "paratransit": "paratransit", "home_in_outage": "home loses power", "no_car": "no car",
    "lives_alone": "lives alone", "wheelchair": "wheelchair", "limited_english": "language support",
}
PROMPT = Path(__file__).with_name("prompts").joinpath("text.md").read_text()


def _reason(codes):
    phrases = []
    for code in codes:
        phrase = REASONS[code]
        if len(" ".join([*phrases, phrase]).split()) <= 20:
            phrases.append(phrase)
    return ("; ".join(phrases).capitalize() if phrases else "No priority reasons recorded") + "."


def _facts(row, clinics, language):
    if language not in ("en", "es", "zh"):
        raise ValueError("unsupported patient language")
    clinic = clinics.get(row["clinic_id"], {})
    slot = row["slot"] if row["action"] in MOVES else None
    return {
        "patient_id": row["patient_id"], "rank": row["rank"], "action": row["action"],
        "reasons": list(row["reasons"]), "reason_text": _reason(row["reasons"]),
        "clinic_name": clinic.get("name", ""), "clinic_address": clinic.get("address", ""),
        "day": slot["date"] if slot else "", "time": TIMES[slot["shift"]] if slot else "",
        "pickup_time": datetime.fromisoformat(row["pickup_time"]).strftime("%H:%M") if slot else "",
        "ride": row["ride"], "language": language,
    }


def _call(model, payload):
    row_schema = {"type": "object", "additionalProperties": False,
                  "required": ["patient_id", "reason_text", "messages"], "properties": {
                      "patient_id": {"type": "string"}, "reason_text": {"type": "string"},
                      "messages": {"type": "object", "additionalProperties": False,
                                   "properties": {lang: {"type": "string"} for lang in ("en", "es", "zh")}}}}
    fields = ({"patients": {"type": "array", "items": row_schema}} if "patients" in payload
              else {"summary": {"type": "string"}})
    tools = [{"toolSpec": {"name": "write_plan_text", "description": "Return only the requested plan text.",
                          "inputSchema": {"json": {"type": "object", "additionalProperties": False,
                                                   "required": list(fields), "properties": fields}}}}]
    return bedrock.converse(model, PROMPT, [{"role": "user", "content": [
        {"text": json.dumps(payload, ensure_ascii=False)}]}], tools=tools, tool_choice="write_plan_text")


def _counts(plan):
    counts = {action: str(sum(row["action"] == action for row in plan["patients"]))
              for action in ("early_session", "transfer", "hospital")}
    counts["book_today"] = str(sum(row["book_today"] for row in plan["patients"]))
    summary = (f"{counts['early_session']} patients dialyze early, {counts['transfer']} move to another clinic, "
               f"and {counts['hospital']} need a staff call. Book {counts['book_today']} paratransit rides today.")
    return {"counts": counts, "summary": summary}


def write_plan_text(plan: dict, clinics: list, langs: dict, only_ids: list | None = None) -> dict:
    """Return an independent plan copy, rewriting only selected rows when requested."""
    model = os.getenv("BEDROCK_MODEL_FAST", "").strip()
    if not model:
        raise ValueError("BEDROCK_MODEL_FAST is required for plan text")
    result = deepcopy(plan)
    selected = [row for row in result["patients"] if only_ids is None or row["patient_id"] in only_ids]
    by_clinic = {clinic["id"]: clinic for clinic in clinics}
    facts = [_facts(row, by_clinic, langs.get(row["patient_id"], "en")) for row in selected]
    if facts:
        output = _call(model, {"patients": facts})["tool_uses"][0]["input"]["patients"]
        by_id = {row["patient_id"]: row for row in output}
        for row in selected:
            row.update({key: by_id[row["patient_id"]][key] for key in ("reason_text", "messages")})
    if only_ids is None:
        result["summary"] = _call(model, _counts(result))["tool_uses"][0]["input"]["summary"]
    return result
