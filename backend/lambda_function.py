"""Lumen API: one Lambda function URL. Routes on method and path (contracts/api.md)."""

import base64
import hmac
import json
import os
import time
import traceback
from datetime import datetime, timedelta

from lumen import store
from lumen.affected import find_affected
from lumen.geo import drive_minutes
from lumen.match import match
from lumen.notice import parse_fallback

try:
    from lumen._version import VERSION  # written by scripts/deploy_lambda.sh
except ImportError:
    VERSION = "dev"

DEMO_CLOCK_DELAY = timedelta(minutes=30)  # demo "now" = the notice's issued_at + 30 min (master plan section 5)
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


# AI-lane functions are imported when called, so the router runs before they land.
def parse_with_bedrock(text):
    from lumen.ai.parse import parse_notice
    return parse_notice(text)


def rank(affected, patients, rules, drive):
    from lumen.ai.rank import rank_patients
    return rank_patients(affected, patients, rules, drive)


def demo_now(event):
    return datetime.fromisoformat(event["issued_at"]) + DEMO_CLOCK_DELAY


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
    start = time.perf_counter()
    try:
        event, source = parse_with_bedrock(text), "bedrock"
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
    return event


def plan(body):
    event_id = body.get("event_id")
    if not event_id:
        raise ApiError(400, "event_id is required", "plan")
    event = store.load_event(event_id)
    if not event:
        raise ApiError(404, f"no event {event_id}", "plan")
    start = time.perf_counter()
    timing = {}
    seed = timed(timing, "store", store.load_seed)
    clinics, patients, rules = seed["clinics"], seed["patients"], seed["rules"]
    now = demo_now(event)
    affected = timed(timing, "affected", find_affected, event, clinics, patients, seed["outage_area"], now, rules["modes"])
    drive = timed(timing, "drive", drive_minutes, patients, clinics)
    ranked = timed(timing, "rank", rank, affected, patients, rules, drive)
    matched = timed(timing, "match", match, ranked, affected, patients, clinics, rules, drive)
    timing["total"] = round((time.perf_counter() - start) * 1000)
    new = {
        "event_id": event_id, "version": 1, "created_at": now.isoformat(timespec="seconds"),
        "mode": affected["mode"], "lead_hours": affected["lead_hours"], "timing_ms": timing,
        "patients": matched["patients"], "overflow": matched["overflow"], "audit": [], "summary": "",
    }
    timed(timing, "save", lambda: (store.delete_plans(event_id), store.save_plan(new)))
    return with_names(new, patients)


def reset(_body):
    return {"ok": True, "deleted": store.reset()}


ROUTES = {("GET", "/state"): state, ("POST", "/alert"): alert, ("POST", "/plan"): plan, ("POST", "/reset"): reset}


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
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = None
        if not isinstance(body, dict):
            raise ApiError(400, "the body must be a JSON object", path.strip("/") or "router")
        status, payload = 200, route(body)
    except ApiError as exc:
        status, payload = exc.status, {"error": exc.error, "step": exc.step}
    except Exception as exc:
        log(error=repr(exc)[:500], trace=traceback.format_exc()[-2000:])
        status, payload = 500, {"error": "internal error", "step": path.strip("/") or "router"}
    log(method=method, path=path, status=status, ms=round((time.perf_counter() - start) * 1000), version=VERSION)
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(payload, ensure_ascii=False)}
