"""Lumen API: one Lambda function URL. Routes on method and path (contracts/api.md)."""

import base64
import binascii
import hmac
import json
import logging
import os
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import datetime, timedelta, timezone

from lumen import approve, speak, store, text_fallback, voice
from lumen.affected import find_affected
from lumen.geo import drive_minutes
from lumen.match import match
from lumen.notice import parse_fallback
from lumen.rank_fallback import rank_by_rules
from lumen.replan_tools import build_tools, replan_by_rules

try:
    from lumen._version import VERSION  # written by scripts/deploy_lambda.sh
except ImportError:
    VERSION = "dev"

logging.getLogger().setLevel(logging.INFO)  # the Lambda runtime defaults to WARNING; AI modules log Bedrock calls at INFO

DEMO_CLOCK_DELAY = timedelta(minutes=30)  # demo "now" = the notice's issued_at + 30 min (master plan section 5)
# Seconds a Bedrock step may take before the router uses its rule-based fallback (Lambda timeout is 120 s).
DEADLINES = {"parse": 20, "text": 25, "replan": 45}
MAX_NOTICE_CHARS, MAX_INSTRUCTION_CHARS = 20_000, 500
_pool = ThreadPoolExecutor(max_workers=4)
EVENT_KEYS = ("event_id", "notice_type", "issued_at", "start", "end", "area_name")  # event.schema.json order; source_text is added after


class ApiError(Exception):
    def __init__(self, status, error, step):
        super().__init__(error)
        self.status, self.error, self.step = status, error, step


def log(**fields):
    print(json.dumps(fields, default=str))


def timed(timing, step, fn, *args):
    """Run one pipeline step: one log line with milliseconds, and an {"error", "step"} on failure."""
    start = time.perf_counter()
    try:
        return fn(*args)
    except ApiError:
        raise
    except Exception as exc:
        log(step=step, error=repr(exc)[:500], trace=traceback.format_exc()[-2000:])
        raise ApiError(500, f"{step} failed: {str(exc)[:200]}", step) from exc
    finally:
        timing[step] = round((time.perf_counter() - start) * 1000)
        log(step=step, ms=timing[step])


def with_deadline(step, fn, *args):
    """Run fn; raise TimeoutError after DEADLINES[step] seconds so the caller falls back instead of hitting the Lambda timeout."""
    # shortcut: a timed-out call keeps running in its thread until it ends; it only touches its own working copy
    future = _pool.submit(fn, *args)
    try:
        return future.result(timeout=DEADLINES[step])
    except FutureTimeout:
        raise TimeoutError(f"{step} took longer than {DEADLINES[step]} s") from None


# AI-lane functions are imported when called, so the router runs before they land.
def parse_with_bedrock(text):
    from lumen.ai.parse import parse_notice
    return parse_notice(text)


def rank(affected, patients, rules, drive):
    """AI-lane rank_patients; the rule-based rank (master plan 8.4) when it fails or has not landed."""
    try:
        from lumen.ai.rank import rank_patients
        return rank_patients(affected, patients, rules, drive)
    except Exception as exc:
        log(step="rank", fallback=True, reason=repr(exc)[:300])
        return rank_by_rules(affected, patients, rules, drive)


def replan_with_bedrock(instruction, plan, tools, clinics):
    from lumen.ai.replan import replan
    return replan(instruction, plan, tools, clinics)  # seed clinics: names and slots for the model, no patient data


def write_text(plan, seed, sources, only_ids=None):
    """Bedrock text (write_plan_text), else AI's code templates in each patient's language (template_plan_text),
    else the English template. sources["text"] is "bedrock" or "fallback"."""
    langs = {p["id"]: p["language"] for p in seed["patients"]}
    try:
        from lumen.ai.text import write_plan_text
        out = with_deadline("text", write_plan_text, plan, seed["clinics"], langs, only_ids)
        if not isinstance(out, dict) or "patients" not in out:
            raise ValueError("write_plan_text did not return a plan")
        log(step="text", source="bedrock")
        sources["text"] = "bedrock"
        return out
    except Exception as exc:
        log(step="text", fallback=True, reason=repr(exc)[:300])
        sources["text"] = "fallback"
    try:
        from lumen.ai.text import template_plan_text
        out = template_plan_text(plan, seed["clinics"], langs, only_ids)
        if not isinstance(out, dict) or "patients" not in out:
            raise ValueError("template_plan_text did not return a plan")
        log(step="text", source="template_plan_text")
        return out
    except Exception as exc:
        log(step="text", fallback=True, source="text_fallback", reason=repr(exc)[:300])
        return text_fallback.fill(plan, seed["clinics"], only_ids)


def demo_now(event):
    """The plan's fixed demo clock: the notice's issued_at + 30 min."""
    return datetime.fromisoformat(event["issued_at"]) + DEMO_CLOCK_DELAY


def clock(event):
    """A demo clock that moves: demo_now plus the real time since the alert (for created_at and audit entries)."""
    saved = store.get_json(f"plans/{event['event_id']}/clock.json")
    elapsed = datetime.now(timezone.utc) - datetime.fromisoformat(saved["alert_at"]) if saved else timedelta(0)
    return demo_now(event) + min(max(elapsed, timedelta(0)), timedelta(hours=12))


def latest(body, step):
    event_id = body.get("event_id")
    if not event_id:
        raise ApiError(400, "event_id is required", step)
    plan = store.latest_plan(event_id)
    if not plan:
        raise ApiError(404, f"no plan for {event_id}", step)
    return event_id, plan


def with_names(plan, patients):
    """Stored plans keep the {name} placeholder; only HTTP responses carry names."""
    names = {p["id"]: p["name"] for p in patients}
    rows = [{**r, "messages": {lang: text.replace("{name}", names.get(r["patient_id"], "")) for lang, text in r["messages"].items()}}
            for r in plan["patients"]]
    return {**plan, "patients": rows}


def state(_body):
    seed = store.load_seed()
    event = store.latest_event()
    plan = store.latest_plan(event["event_id"]) if event else None
    affected = None
    if event:
        affected = find_affected(event, seed["clinics"], seed["patients"], seed["outage_area"], demo_now(event), seed["rules"]["modes"])
    return {"version": VERSION, **seed, "event": event, "affected": affected,
            "plan": with_names(plan, seed["patients"]) if plan else None}


def alert(body):
    text = body.get("notice_text")
    if not isinstance(text, str) or not text.strip():
        raise ApiError(400, "notice_text is required", "alert")
    if len(text) > MAX_NOTICE_CHARS:
        raise ApiError(400, f"notice_text is longer than {MAX_NOTICE_CHARS} characters", "alert")
    start = time.perf_counter()
    try:
        event, source = with_deadline("parse", parse_with_bedrock, text), "bedrock"
        missing = set(EVENT_KEYS) - set(event)
        if missing:
            raise ValueError(f"Bedrock parse missed {sorted(missing)}")
    except Exception as exc:
        log(step="parse", fallback=True, reason=repr(exc)[:300])
        try:
            event, source = parse_fallback(text), "fallback"
        except ValueError as exc2:
            raise ApiError(400, f"could not parse the notice: {exc2}", "parse") from exc2
    log(step="parse", source=source, ms=round((time.perf_counter() - start) * 1000))
    event = {**{k: event[k] for k in EVENT_KEYS}, "source_text": text, "parse_source": source}
    store.save_event(event)
    store.put_json(f"plans/{event['event_id']}/clock.json", {"alert_at": datetime.now(timezone.utc).isoformat()})
    return event


def plan(body):
    event_id = body.get("event_id")
    if not event_id:
        raise ApiError(400, "event_id is required", "plan")
    event = store.load_event(event_id)
    if not event:
        raise ApiError(404, f"no event {event_id}", "plan")
    start = time.perf_counter()
    timing, sources = {}, {}
    seed = timed(timing, "store", store.load_seed)
    clinics, patients, rules = seed["clinics"], seed["patients"], seed["rules"]
    now = demo_now(event)
    affected = timed(timing, "affected", find_affected, event, clinics, patients, seed["outage_area"], now, rules["modes"])
    drive = timed(timing, "drive", drive_minutes, patients, clinics)
    ranked = timed(timing, "rank", rank, affected, patients, rules, drive)
    matched = timed(timing, "match", match, ranked, affected, patients, clinics, rules, drive)
    new = {
        "event_id": event_id, "version": 1, "created_at": clock(event).isoformat(timespec="seconds"),
        "mode": affected["mode"], "lead_hours": affected["lead_hours"], "timing_ms": timing, "ai_sources": sources,
        "patients": matched["patients"], "overflow": matched["overflow"], "audit": [], "summary": "",
    }
    new = timed(timing, "text", write_text, new, seed, sources)
    new["timing_ms"], new["ai_sources"] = timing, sources  # the text step returns a deep copy made before total and its source were set
    timing["total"] = round((time.perf_counter() - start) * 1000)
    timed({}, "save", lambda: (store.delete_plans(event_id), store.save_plan(new)))  # logged, not in timing_ms: total is final
    return with_names(new, patients)


def replan_route(body):
    event_id, old = latest(body, "replan")
    instruction = body.get("instruction")
    if not isinstance(instruction, str) or not instruction.strip():
        raise ApiError(400, "instruction is required", "replan")
    if len(instruction) > MAX_INSTRUCTION_CHARS:
        raise ApiError(400, f"instruction is longer than {MAX_INSTRUCTION_CHARS} characters", "replan")
    start = time.perf_counter()
    timing, sources = {}, {}
    seed = timed(timing, "store", store.load_seed)
    tools = timed(timing, "tools", build_tools, event_id, old, seed)
    t = time.perf_counter()
    try:
        result, sources["replan"] = with_deadline("replan", replan_with_bedrock, instruction, old, tools, seed["clinics"]), "bedrock"
        log(step="replan", source="bedrock")
    except Exception as exc:
        log(step="replan", fallback=True, reason=repr(exc)[:300])
        try:  # fresh tools: a failed Bedrock loop may have changed the working copy
            result, sources["replan"] = replan_by_rules(instruction, old, build_tools(event_id, old, seed), seed["clinics"]), "fallback"
        except ValueError as exc2:
            raise ApiError(400, str(exc2), "replan") from exc2
    timing["replan"] = round((time.perf_counter() - t) * 1000)
    changed = sorted({d["patient_id"] for d in result["diff"]})
    now = clock(store.load_event(event_id)).isoformat(timespec="seconds")
    new = {**old, "version": old["version"] + 1, "created_at": now,
           "patients": result["plan"]["patients"], "overflow": result["plan"]["overflow"], "summary": result["summary"],
           "audit": old["audit"] + [{"ts": now, "actor": "Rosa", "change": f"re-plan: {instruction.strip()[:200]}"}]}
    new = timed(timing, "text", write_text, new, seed, sources, changed)
    new["summary"] = result["summary"]
    timing["total"] = round((time.perf_counter() - start) * 1000)
    new["timing_ms"], new["ai_sources"] = timing, sources  # replaces the ai_sources copied from the old version
    save_new_version(new, "replan")
    return {"plan": with_names(new, seed["patients"]), "diff": result["diff"], "summary": result["summary"]}


def approve_route(body):
    event_id, old = latest(body, "approve")
    try:
        new = approve.apply(old, body.get("patient_ids", []), body.get("edits", []), clock(store.load_event(event_id)))
    except approve.UnknownPatient as exc:
        raise ApiError(404, str(exc), "approve") from exc
    except ValueError as exc:
        raise ApiError(400, str(exc), "approve") from exc
    save_new_version(new, "approve")
    return with_names(new, store.load_seed()["patients"])


def voice_route(body):
    event_id, plan = latest(body, "voice")
    patient_id, lang = body.get("patient_id"), body.get("lang")
    if not isinstance(patient_id, str) or not isinstance(lang, str) or lang not in voice.VOICES:
        raise ApiError(400, "patient_id and lang (en, es or zh) are required", "voice")
    row = next((r for r in plan["patients"] if r["patient_id"] == patient_id), None)
    if row is None:
        raise ApiError(404, f"no patient {patient_id} in the plan", "voice")
    reason = voice.eligible(row, lang)
    if reason:
        raise ApiError(409, reason, "voice")
    key = timed({}, "voice", voice.make_voice, event_id, patient_id, lang, row["messages"][lang])
    if row["audio"].get(lang) != key:  # record the key on the current version; no new version for audio
        row["audio"][lang] = key
        store.save_plan(plan)
    return {"url": voice.presign(key)}


def speak_route(body):
    text, lang = body.get("text"), body.get("lang")
    if not isinstance(text, str) or not text.strip() or len(text) > speak.MAX_CHARS:
        raise ApiError(400, f"text of 1 to {speak.MAX_CHARS} characters is required", "speak")
    if not isinstance(lang, str) or lang not in speak.LANGS:
        raise ApiError(400, f"lang must be one of {', '.join(speak.LANGS)}", "speak")
    translated = body.get("translated", False)
    if not isinstance(translated, bool):
        raise ApiError(400, "translated must be true or false", "speak")
    try:
        return timed({}, "speak", speak.speak, text, lang, translated)
    except ApiError as exc:
        if isinstance(exc.__cause__, speak.TranslateDenied):  # until Vi adds translate:TranslateText to the Lambda role
            raise ApiError(500, "translate not permitted", "speak") from None
        raise


def save_new_version(plan, step):
    """Write v(N+1) only if no other request wrote it first; the loser gets 409 instead of overwriting."""
    try:
        store.save_plan(plan, new=True)
    except store.VersionTaken as exc:
        raise ApiError(409, "the plan changed while you edited it; reload and try again", step) from exc


def reset(_body):
    return {"ok": True, "deleted": store.reset()}


ROUTES = {("GET", "/state"): state, ("POST", "/alert"): alert, ("POST", "/plan"): plan, ("POST", "/replan"): replan_route,
          ("POST", "/approve"): approve_route, ("POST", "/voice"): voice_route, ("POST", "/speak"): speak_route,
          ("POST", "/reset"): reset}


def lambda_handler(event, context):
    start = time.perf_counter()
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/").rstrip("/") or "/"
    try:
        headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        key = os.environ.get("DEMO_KEY", "")
        if not key or not hmac.compare_digest(headers.get("x-demo-key", "").encode(), key.encode()):
            raise ApiError(401, "bad demo key", "auth")
        route = ROUTES.get((method, path))
        if route is None:
            raise ApiError(404, f"no route {method} {path}", "router")
        raw = event.get("body") or "{}"
        try:
            body = json.loads(base64.b64decode(raw).decode() if event.get("isBase64Encoded") else raw)
        except (json.JSONDecodeError, UnicodeDecodeError, binascii.Error):
            body = None
        if not isinstance(body, dict):
            raise ApiError(400, "the body must be a JSON object", path.strip("/") or "router")
        status, payload = 200, route(body)
    except ApiError as exc:
        status, payload = exc.status, {"error": exc.error, "step": exc.step}
    except Exception as exc:
        log(error=repr(exc)[:500], trace=traceback.format_exc()[-2000:])
        status, payload = 500, {"error": "internal error", "step": path.strip("/") or "router"}
    log(method=method, path=path, status=status, ms=round((time.perf_counter() - start) * 1000), version=VERSION,
        request_id=getattr(context, "aws_request_id", None), **({"error": payload["error"]} if status >= 400 else {}))
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(payload, ensure_ascii=False)}
