"""Generate plan text from a small, name-free set of preformatted facts."""

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
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
BANNED = re.compile(r"\b(?:death\w*|dead\w*|die|dies|died|dying|danger\w*|risk\w*|fatal\w*|lethal\w*|"
                    r"mortal\w*|muert\w*|muer\w*|murio|morir\w*|fallec\w*|pelig\w*|riesg\w*)\b|致命|丧命|[死亡危险險]", re.I)
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
ZH_CHARS = set("您的治疗透析已调整改到安排在请于出发前离家等候车辆来接送您如有问题致电咨询停电计划时间地点死亡危险风险")


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
        return "message_type"
    if message.count("{name}") != 1 or not re.search(r"(?<![\w{}])\{name\}(?![\w{}])", message):
        return "name_placeholder"
    if (len(message) > 80 if lang == "zh" else len(message.split()) >= 40):
        return "message_length"
    if any(unicodedata.category(c)[0] in "CS" or c in "\ufe0e\ufe0f\u20e3" for c in message):
        return "unsupported_character"
    if BANNED.search(_plain(message)):
        return "banned_word"
    times = [facts["time"], facts["pickup_time"]]
    if CLOCK.findall(message) != times:
        return "time_strings"
    if not message.startswith(facts["day"] + " " + facts["time"]) or facts["clinic_name"] not in message:
        return "time_place_first"
    if message.index(facts["clinic_name"]) > message.index("{name}"):
        return "place_first"
    if not _language_ok(message, facts, lang):
        return "language"
    if not _ride_ok(message, facts, lang):
        return "pickup_wording"
    return None


def _ride_ok(message, facts, lang):
    clocks = list(CLOCK.finditer(message))
    if len(clocks) != 2:
        return False
    own = facts["ride"] in ("self", "family")
    before, after = message[:clocks[1].start()], message[clocks[1].end():]
    if lang == "zh":
        return bool(re.match(r"(?:请)?(?:出发|离家)" if own else r"(?:接您|等候接送)", after))
    if lang == "en":
        pattern = r"leave home by\s*$" if own else r"(?:ride|paratransit|transport) picks you up at\s*$"
    else:
        pattern = r"salga de casa a las\s*$" if own else r"transporte le recoge a las\s*$"
    return bool(re.search(pattern, _plain(before)))


def _row_error(row, facts):
    if set(row) != {"patient_id", "reason_text", "messages"} or row.get("reason_text") != facts["reason_text"]:
        return "row_fields_or_reason"
    messages = row.get("messages")
    langs = (["en"] if facts["language"] == "en" else ["en", facts["language"]]) if facts["time"] else []
    if not isinstance(messages, dict) or set(messages) != set(langs):
        return "message_languages"
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
    bad_batch = ({}, {pid: "batch_shape" for pid in expected})
    if not isinstance(body, dict) or set(body) != {"patients"} or not isinstance(body["patients"], list):
        return bad_batch
    rows = body["patients"]
    good, errors, seen = {}, {pid: "missing_row" for pid in expected}, set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        pid = row.get("patient_id")
        if not isinstance(pid, str) or pid not in expected or pid in seen:
            continue
        seen.add(pid)
        errors.pop(pid)
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


def _batch(model, facts, fallback_ids):
    good, errors = {}, {}
    for attempt in range(2):
        payload = {"patients": facts, **({"errors": errors} if attempt else {})}
        response = _call(model, payload)
        if isinstance(response, dict) and response.get("stop_reason") == "max_tokens" and len(facts) > 1:
            middle = len(facts) // 2
            return {**_batch(model, facts[:middle], fallback_ids), **_batch(model, facts[middle:], fallback_ids)}
        valid, errors = _validated(response, facts)
        good.update(valid)
        if not errors:
            return good
    for facts_row in facts:
        pid = facts_row["patient_id"]
        if pid not in good:
            good[pid] = _template(facts_row)
            fallback_ids.add(pid)
            logger.warning("text fallback patient_id=%s error=%s", pid, errors.get(pid, "missing_row"))
    return good


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
    fields = {"patients": {"type": "array", "items": row_schema}}
    tools = [{"toolSpec": {"name": "write_plan_text", "description": "Return only the requested plan text.",
                          "inputSchema": {"json": {"type": "object", "additionalProperties": False,
                                                   "required": list(fields), "properties": fields}}}}]
    return bedrock.converse(model, PROMPT, [{"role": "user", "content": [
        {"text": json.dumps(payload, ensure_ascii=False)}]}], tools=tools, tool_choice="write_plan_text")


def _summary(plan):
    counts = {action: sum(row["action"] == action for row in plan["patients"])
              for action in ("early_session", "transfer", "hospital")}
    early, transfers, hospital = (counts[action] for action in MOVES + ("hospital",))
    rides = sum(row["book_today"] for row in plan["patients"])
    return (f"{early} {'patient dialyzes' if early == 1 else 'patients dialyze'} early, "
            f"{transfers} {'moves' if transfers == 1 else 'move'} to another clinic, "
            f"and {hospital} {'needs' if hospital == 1 else 'need'} a staff call. "
            f"Book {rides} paratransit {'ride' if rides == 1 else 'rides'} today.")


def write_plan_text(plan: dict, clinics: list, langs: dict, only_ids: list | None = None) -> dict:
    """Return an independent plan copy, rewriting only selected rows when requested."""
    model = os.getenv("BEDROCK_MODEL_FAST", "").strip()
    if not model:
        raise ValueError("BEDROCK_MODEL_FAST is required for plan text")
    result = deepcopy(plan)
    selected = [row for row in result["patients"] if only_ids is None or row["patient_id"] in only_ids]
    by_clinic = {clinic["id"]: clinic for clinic in clinics}
    facts = [_facts(row, by_clinic, langs.get(row["patient_id"], "en")) for row in selected]
    fallback_ids = set()
    if facts:
        batches = [facts[start:start + 10] for start in range(0, len(facts), 10)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            by_id = {pid: row for batch in pool.map(lambda rows: _batch(model, rows, fallback_ids), batches)
                     for pid, row in batch.items()}
        for row in selected:
            row.update({key: by_id[row["patient_id"]][key] for key in ("reason_text", "messages")})
    if only_ids is None:
        result["summary"] = _summary(result)
    logger.info("text generation bedrock_rows=%d template_rows=%d", len(facts) - len(fallback_ids), len(fallback_ids))
    return result
