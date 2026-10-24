"""Generate plan text from a small, name-free set of preformatted facts."""

from copy import deepcopy
from datetime import datetime
import json
import logging
import os
from pathlib import Path
import re
import unicodedata

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
logger = logging.getLogger(__name__)
CLOCK = re.compile(r"(?<!\d)\d{1,2}[:：.]\d{2}(?:\s*[ap]\.?m\.?)?|\b\d{1,2}\s*[ap]\.?m\.?|"
                   r"[零一二三四五六七八九十两\d]+[点點时時](?:[零一二三四五六七八九十两\d分半刻]+)?", re.I)
BANNED = re.compile(r"\b(?:death\w*|dead\w*|die|dies|died|dying|danger\w*|risk\w*|fatal\w*|"
                    r"mortal\w*|muert\w*|muer\w*|morir|fallec\w*|pelig\w*|riesg\w*)\b|[死危险險]", re.I)
# A deliberately small vocabulary keeps ambiguous/mixed-language prose out.
WORDS = {
    "en": set("your treatment has moved is scheduled dialysis session appointment on at to for a the "
              "planned power shutoff please leave home by ride picks you up paratransit transport "
              "questions call come arrive starts new time clinic this an and will be now changed "
              "death danger risk".split()),
    "es": set("su tratamiento cambio cambiado esta programado dialisis sesion cita el la los las un una "
              "por corte de luz apagon previsto favor salga casa antes a en transporte adaptado le recoge "
              "recogera recogida preguntas llame al llegue comienza nuevo horario clinica para se ha "
              "muerte peligro riesgo".split()),
}
ZH_CHARS = set("您的治疗透析已调整改到安排在请于出发前离家等候车辆来接您如有问题致电咨询停电计划时间地点死亡危险风险")


def _plain(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(c))


def _language_ok(message, facts, lang):
    remainder = message.replace("{name}", "").replace("555-0100", "")
    for value in sorted({facts["day"], facts["clinic_name"], facts["clinic_address"],
                         facts["clinic_address"].split(",")[0]}, key=len, reverse=True):
        if value:
            remainder = remainder.replace(value, "")
    remainder = CLOCK.sub("", remainder)
    letters = re.findall(r"[^\W\d_]", remainder, re.UNICODE)
    if re.search(r"\d", remainder):
        return False
    if lang == "zh":
        return len(letters) >= 2 and set(letters) <= ZH_CHARS
    words = set(re.findall(r"[^\W\d_]+", _plain(remainder)))
    markers = {"treatment", "dialysis", "session"} if lang == "en" else {"tratamiento", "dialisis", "sesion"}
    return bool(words & markers) and words <= WORDS[lang]


def _message_error(message, facts, lang):
    if not isinstance(message, str):
        return "message type"
    if message.count("{name}") != 1:
        return "name placeholder"
    if (len(message) > 80 if lang == "zh" else len(message.split()) >= 40):
        return "message length"
    if BANNED.search(_plain(message)):
        return "banned wording"
    times = {facts["time"], facts["pickup_time"]}
    if not all(clock in message for clock in times) or set(CLOCK.findall(message)) != times:
        return "time strings"
    if not message.startswith(facts["day"] + " " + facts["time"]) or facts["clinic_name"] not in message:
        return "time and place first"
    if message.index(facts["clinic_name"]) > message.index("{name}"):
        return "place first"
    if not _language_ok(message, facts, lang):
        return "language"
    return None


def _row_error(row, facts):
    if set(row) != {"patient_id", "reason_text", "messages"} or row.get("reason_text") != facts["reason_text"]:
        return "row fields or reason"
    messages = row.get("messages")
    langs = (["en"] if facts["language"] == "en" else ["en", facts["language"]]) if facts["time"] else []
    if not isinstance(messages, dict) or set(messages) != set(langs):
        return "message languages"
    return next((error for lang in langs if (error := _message_error(messages[lang], facts, lang))), None)


def _body(response):
    if not isinstance(response, dict) or response.get("stop_reason") != "tool_use":
        return None
    uses = response.get("tool_uses")
    if not isinstance(uses, list) or len(uses) != 1 or not isinstance(uses[0], dict):
        return None
    return uses[0].get("input") if uses[0].get("name") == "write_plan_text" else None


def _validated(response, facts):
    body = _body(response)
    expected = {row["patient_id"]: row for row in facts}
    bad_batch = ({}, {pid: "batch shape or IDs" for pid in expected})
    if not isinstance(body, dict) or set(body) != {"patients"} or not isinstance(body["patients"], list):
        return bad_batch
    rows = body["patients"]
    if any(not isinstance(row, dict) or not isinstance(row.get("patient_id"), str) for row in rows):
        return bad_batch
    ids = [row["patient_id"] for row in rows]
    if len(set(ids)) != len(ids) or set(ids) - expected.keys():
        return bad_batch
    good, errors = {}, {pid: "missing row" for pid in expected.keys() - set(ids)}
    for row in rows:
        pid = row["patient_id"]
        if error := _row_error(row, expected[pid]):
            errors[pid] = error
        else:
            good[pid] = {**row, "messages": {lang: row["messages"][lang] for lang in ("en", "es", "zh")
                                            if lang in row["messages"]}}
    return good, errors


def _template(facts):
    messages = {}
    if facts["time"]:
        day, clock, clinic, pickup = (facts[k] for k in ("day", "time", "clinic_name", "pickup_time"))
        own_ride = facts["ride"] in ("self", "family")
        ride = f"Please leave home by {pickup}." if own_ride else f"A ride picks you up at {pickup}."
        viaje = f"Salga de casa a las {pickup}." if own_ride else f"Un transporte le recoge a las {pickup}."
        prefix = f"{day} {clock}, {clinic}"
        messages["en"] = f"{prefix}. {{name}}, your treatment has moved. {ride} Questions? Call 555-0100."
        if facts["language"] == "es":
            messages["es"] = f"{prefix}. {{name}}, su tratamiento cambió. {viaje} ¿Preguntas? Llame al 555-0100."
        if facts["language"] == "zh":
            travel = "请出发" if own_ride else "接您"
            messages["zh"] = f"{day} {clock}，{clinic}。{{name}}，治疗已调整；{pickup}{travel}。"
    result = {"patient_id": facts["patient_id"], "reason_text": facts["reason_text"], "messages": messages}
    if _row_error(result, facts):
        raise ValueError("plan facts cannot fit message limits")
    return result


def _batch(model, facts):
    good, errors = {}, {}
    for attempt in range(2):
        payload = {"patients": facts, **({"errors": errors} if attempt else {})}
        valid, errors = _validated(_call(model, payload), facts)
        good.update(valid)
        if not errors:
            return good
    for facts_row in facts:
        pid = facts_row["patient_id"]
        if pid not in good:
            good[pid] = _template(facts_row)
            logger.warning("text fallback patient_id=%s", pid)
    return good


def _summary(model, plan):
    payload = _counts(plan)
    for attempt in range(2):
        body = _body(_call(model, {**payload, **({"errors": ["summary must match supplied counts"]} if attempt else {})}))
        if isinstance(body, dict) and body == {"summary": payload["summary"]}:
            return body["summary"]
    logger.warning("text summary fallback")
    return payload["summary"]


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
        by_id = _batch(model, facts)
        for row in selected:
            row.update({key: by_id[row["patient_id"]][key] for key in ("reason_text", "messages")})
    if only_ids is None:
        result["summary"] = _summary(model, result)
    return result
