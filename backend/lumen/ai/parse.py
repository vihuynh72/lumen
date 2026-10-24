"""Parse a shutoff notice into the event JSON with one forced Bedrock tool call."""

from datetime import datetime
import json
import logging
import os
from pathlib import Path
import re

from lumen.ai import bedrock


logger = logging.getLogger(__name__)
PROMPT = Path(__file__).with_name("prompts").joinpath("parse.md").read_text()
KEYS = ("event_id", "notice_type", "issued_at", "start", "end", "area_name")
NOTICE_TYPES = ("watch", "warning", "cancel")
_TIME = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$",
         "description": "ISO 8601 with an explicit offset, for example 2026-10-27T18:00:00-07:00."}
# Copy of contracts/schemas/event.schema.json minus what the router sets ($schema, $id, parse_source,
# source_text), with $ref inlined. The Lambda package has no contracts/, so a test pins it to the contract.
TOOL_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": list(KEYS),
    "properties": {
        "event_id": {"type": "string", "minLength": 1,
                     "description": "Event ID from the notice, for example PSPS-DEMO-01."},
        "notice_type": {"type": "string", "enum": list(NOTICE_TYPES),
                        "description": "A cancel notice reuses start and end from the original event when it does not restate them."},
        "issued_at": {**_TIME, "description": "When the utility issued the notice."},
        "start": {**_TIME, "description": "Estimated power-off time."},
        "end": {**_TIME, "description": "Estimated restoration time."},
        "area_name": {"type": "string", "minLength": 1,
                      "description": "Area name exactly as written in the notice. Matches outage_area.geojson properties.event_area."},
    },
}
TOOLS = [{"toolSpec": {"name": "record_event", "description": "Record the parsed shutoff notice.",
                       "inputSchema": {"json": TOOL_SCHEMA}}}]


class _Invalid(ValueError):
    """The model's reply is wrong; the only error parse_notice retries."""


def _time(event, key):
    value = event[key]
    if not isinstance(value, str) or not re.fullmatch(_TIME["pattern"], value, re.ASCII):
        raise _Invalid(f"{key} must match YYYY-MM-DDTHH:MM:SS+hh:mm (numeric offset), got {value!r:.40}")
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise _Invalid(f"{key} is not a real date and time: {value!r:.40}") from None


def _norm(value):
    return " ".join(value.split()).casefold()


def _validate(tool_uses, notice_text):
    """Return the event from the single record_event call, or raise _Invalid saying what is wrong."""
    if len(tool_uses) != 1 or tool_uses[0]["name"] != "record_event":
        raise _Invalid("call the tool record_event exactly once and call no other tool")
    event = tool_uses[0]["input"]
    if not isinstance(event, dict):
        raise _Invalid("the record_event input must be an object")
    missing = [k for k in KEYS if k not in event]
    if missing:
        raise _Invalid(f"missing keys: {missing}")
    for key in ("event_id", "area_name"):
        if not isinstance(event[key], str) or not event[key].strip():
            raise _Invalid(f"{key} must be a non-empty string")
        if _norm(event[key]) not in _norm(notice_text):
            raise _Invalid(f"{key} does not appear in the notice; use the text exactly as written")
    if event["notice_type"] not in NOTICE_TYPES:
        raise _Invalid(f"notice_type must be one of {list(NOTICE_TYPES)}, got {str(event['notice_type'])!r:.40}")
    start, end = (_time(event, k) for k in ("start", "end"))
    _time(event, "issued_at")
    if end <= start:
        raise _Invalid("end must be after start")
    return {**{k: event[k] for k in KEYS}, "event_id": event["event_id"].strip(),
            "area_name": event["area_name"].strip()}


def _ask(model, payload):
    reply = bedrock.converse(model, PROMPT, [{"role": "user", "content": [{"text": json.dumps(payload)}]}],
                             tools=TOOLS, tool_choice="record_event")
    return reply["tool_uses"]


def parse_notice(notice_text: str) -> dict:
    """Event JSON (contracts/schemas/event.schema.json) from the notice; Bedrock errors propagate."""
    if not isinstance(notice_text, str) or not notice_text.strip():
        raise ValueError("notice_text must be a non-empty string")
    model = os.getenv("BEDROCK_MODEL_FAST")
    if not model:
        raise RuntimeError("BEDROCK_MODEL_FAST is not set")
    payload = {"notice_text": notice_text}
    try:
        event = _validate(_ask(model, payload), notice_text)
    except _Invalid as error:
        # One fresh call, no sleep: the router gives parse 20 s in total.
        logger.info("parse retry: %s", error)
        event = _validate(_ask(model, {**payload, "validation_error": str(error)}), notice_text)
    return {**event, "source_text": notice_text}
