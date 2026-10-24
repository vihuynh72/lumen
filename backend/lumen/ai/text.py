"""Generate plan text from a small, name-free set of preformatted facts."""

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
import json
import logging
import os
from pathlib import Path
import re
import unicodedata
from threading import Lock
from time import monotonic

from botocore.exceptions import BotoCoreError, ClientError

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
CLOCK = re.compile(
    r"(?<![0-9])(?:[0-9]{1,2}[:：.][0-9]{2}(?:\s*(?:[ap]\.\s*m\.|[ap]m)(?![a-z]))?|"
    r"[0-9]{1,2}\s*(?:[ap]\.\s*m\.|[ap]m)(?![a-z]))|"
    r"[零一二三四五六七八九十两0-9]+[点點时時](?:[零一二三四五六七八九十两0-9分半刻]+)?", re.I)

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
    for value in sorted({*facts["strings"][lang].values(), facts["clinic_name"], facts["clinic_address"],
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
    when, pickup = (facts["strings"][lang][key] for key in ("when", "pickup_time"))
    remainder = message.replace(when, "", 1)
    if when not in message or pickup not in remainder or CLOCK.search(remainder.replace(pickup, "", 1)):
        return "time_strings"
    if not message.startswith(when) or facts["clinic_name"] not in message:
        return "time_place_first"
    if message.index(facts["clinic_name"]) > message.index("{name}"):
        return "place_first"
    if not _language_ok(message, facts, lang):
        return "language"
    if not _ride_ok(message, facts, lang):
        return "pickup_wording"
    return None


def _ride_ok(message, facts, lang):
    when, pickup = (facts["strings"][lang][key] for key in ("when", "pickup_time"))
    position = message.find(pickup, len(when))
    if position < 0:
        return False
    own = facts["ride"] in ("self", "family")
    before, after = message[:position], message[position + len(pickup):]
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
    langs = (["en"] if facts["language"] == "en" else ["en", facts["language"]]) if facts["strings"] else []
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
    for lang, strings in facts["strings"].items():
        when, pickup = strings["when"], strings["pickup_time"]
        clinic = facts["clinic_name"]
        own = facts["ride"] in ("self", "family")
        if lang == "en":
            ride = f"Please leave home by {pickup}." if own else f"A ride picks you up at {pickup}."
            message = f"{when}, {clinic}. {{name}}, your treatment has moved. {ride}"
            callback = " Questions? Call 555-0100."
        elif lang == "es":
            ride = f"Salga de casa a las {pickup}." if own else f"Un transporte le recoge a las {pickup}."
            message = f"{when}, {clinic}. {{name}}, su tratamiento cambió. {ride}"
            callback = " ¿Preguntas? Llame al 555-0100."
        else:
            ride = "请出发" if own else "接您"
            message = f"{when}，{clinic}。{{name}}，治疗已调整；{pickup}{ride}。"
            callback = ""
        messages[lang] = message + callback if len((message + callback).split()) < 40 else message
    result = {"patient_id": facts["patient_id"], "reason_text": facts["reason_text"], "messages": messages}
    if _row_error(result, facts):
        raise ValueError("plan facts cannot fit message limits")
    return result


class _BudgetExhausted(Exception):
    """A local limit, not an AWS failure."""


class _Budget:
    def __init__(self):
        self.deadline = monotonic() + 20
        self.calls = 0
        self.lock = Lock()

    def acquire(self, reserve=True):
        with self.lock:
            if monotonic() >= self.deadline:
                raise _BudgetExhausted("deadline")
            if reserve:
                if self.calls >= 30:
                    raise _BudgetExhausted("call_limit")
                self.calls += 1

    def call(self, model, payload):
        # Reserve the initial attempt even when converse is replaced by a test stub.
        self.acquire()
        first = True

        def before_attempt():
            nonlocal first
            self.acquire(reserve=not first)
            first = False

        # Recheck the deadline at the SDK boundary; count adapter retries too.
        with bedrock.attempt_guard(before_attempt):
            return _call(model, payload)


@dataclass
class _BatchResult:
    rows: dict
    errors: dict
    failures: list


def _batch(model, facts, budget):
    good, errors = {}, {}
    for attempt in range(2):
        payload = {"patients": facts, **({"errors": errors} if attempt else {})}
        try:
            response = budget.call(model, payload)
        except _BudgetExhausted as error:
            return _BatchResult(good, {row["patient_id"]: str(error) for row in facts}, [])
        except (ClientError, BotoCoreError, TimeoutError) as error:
            return _BatchResult(good, {row["patient_id"]: type(error).__name__ for row in facts}, [error])
        if isinstance(response, dict) and response.get("stop_reason") == "max_tokens" and len(facts) > 1:
            middle = len(facts) // 2
            left, right = (_batch(model, part, budget) for part in (facts[:middle], facts[middle:]))
            return _BatchResult({**good, **left.rows, **right.rows}, {**left.errors, **right.errors},
                                left.failures + right.failures)
        valid, errors = _validated(response, facts)
        good.update(valid)
        if not errors:
            break
    return _BatchResult(good, errors, [])



def _reason(codes):
    phrases = []
    for code in codes:
        phrase = REASONS[code]
        if len(" ".join([*phrases, phrase]).split()) <= 20:
            phrases.append(phrase)
    return ("; ".join(phrases).capitalize() if phrases else "No priority reasons recorded") + "."


# Explicit names avoid process-global locale changes in worker threads.
WEEKDAYS = {
    "en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
    "es": ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"),
}
MONTHS = {
    "en": ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"),
    "es": ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"),
}


def _clock(value, lang):
    hour, minute = value.hour, value.minute
    clock = f"{hour % 12 or 12}:{minute:02d}"
    if lang == "en":
        return clock + (" AM" if hour < 12 else " PM")
    if lang == "es":
        return clock + (" a. m." if hour < 12 else " p. m.")
    period = "凌晨" if hour < 6 else "上午" if hour < 12 else "中午" if hour == 12 else "下午" if hour < 18 else "晚上"
    return period + clock


def _strings(slot, pickup, languages):
    treatment = datetime.fromisoformat(slot["date"] + "T" + TIMES[slot["shift"]])
    result = {}
    for lang in languages:
        clock = _clock(treatment, lang)
        if lang == "zh":
            when = f"{treatment.month}月{treatment.day}日 周{'一二三四五六日'[treatment.weekday()]} {clock}"
        else:
            day, month = WEEKDAYS[lang][treatment.weekday()], MONTHS[lang][treatment.month - 1]
            when = (f"{day}, {month} {treatment.day} at {clock}" if lang == "en"
                    else f"{day} {treatment.day} de {month} a las {clock}")
        result[lang] = {"when": when, "pickup_time": _clock(pickup, lang)}
    return result


def _facts(row, clinics, language):
    if language not in ("en", "es", "zh"):
        raise ValueError("unsupported patient language")
    clinic = clinics.get(row["clinic_id"], {})
    slot = row["slot"] if row["action"] in MOVES else None
    return {
        "patient_id": row["patient_id"], "rank": row["rank"], "action": row["action"],
        "reasons": list(row["reasons"]), "reason_text": _reason(row["reasons"]),
        "clinic_name": clinic.get("name", ""), "clinic_address": clinic.get("address", ""),
        "strings": _strings(slot, datetime.fromisoformat(row["pickup_time"]),
                            ["en"] if language == "en" else ["en", language]) if slot else {},
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
    """Return a plan copy; start at most 30 attempts within 20s. In-flight calls finish."""
    budget = _Budget()
    model = os.getenv("BEDROCK_MODEL_FAST", "").strip()
    if not model:
        raise ValueError("BEDROCK_MODEL_FAST is required for plan text")
    result = deepcopy(plan)
    selected = [row for row in result["patients"] if only_ids is None or row["patient_id"] in only_ids]
    by_clinic = {clinic["id"]: clinic for clinic in clinics}
    facts = [_facts(row, by_clinic, langs.get(row["patient_id"], "en")) for row in selected]
    template_rows = 0
    if facts:
        batches = [facts[start:start + 10] for start in range(0, len(facts), 10)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcomes = list(pool.map(lambda rows: _batch(model, rows, budget), batches))
        by_id = {pid: row for batch in outcomes for pid, row in batch.rows.items()}
        failures = [error for batch in outcomes for error in batch.failures]
        if failures and not by_id:
            logger.info("text generation bedrock_rows=0 template_rows=0")
            raise failures[0]
        errors = {pid: error for batch in outcomes for pid, error in batch.errors.items()}
        for row, row_facts in zip(selected, facts):
            pid = row["patient_id"]
            if pid not in by_id:
                by_id[pid] = _template(row_facts)
                template_rows += 1
                logger.warning("text fallback patient_id=%s error=%s", pid, errors[pid])
            row.update({key: by_id[pid][key] for key in ("reason_text", "messages")})
    if only_ids is None:
        result["summary"] = _summary(result)
    logger.info("text generation bedrock_rows=%d template_rows=%d", len(facts) - template_rows, template_rows)
    return result
