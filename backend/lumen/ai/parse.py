"""Parse a shutoff notice into the event JSON with one forced Bedrock tool call."""

from datetime import datetime
import os
from pathlib import Path

from lumen.ai import bedrock


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


def _time(event, key):
    value = event[key]
    if not isinstance(value, str):
        raise ValueError(f"{key} must be an ISO 8601 string")
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{key} is not ISO 8601: {value!r}") from None
    if moment.tzinfo is None:
        raise ValueError(f"{key} has no UTC offset: {value!r}")
    return moment


def _validate(tool_uses):
    """Return the event from the first record_event call, or raise ValueError saying what is wrong."""
    event = next((u["input"] for u in tool_uses if u["name"] == "record_event"), None)
    if not isinstance(event, dict):
        raise ValueError("the reply did not call record_event with an object")
    missing = [k for k in KEYS if k not in event]
    if missing:
        raise ValueError(f"missing keys: {missing}")
    for key in ("event_id", "area_name"):
        if not isinstance(event[key], str) or not event[key].strip():
            raise ValueError(f"{key} must be a non-empty string")
    if event["notice_type"] not in NOTICE_TYPES:
        raise ValueError(f"notice_type must be one of {list(NOTICE_TYPES)}, got {event['notice_type']!r}")
    issued, start, end = (_time(event, k) for k in ("issued_at", "start", "end"))
    if end <= start:
        raise ValueError("end must be after start")
    if issued > start:
        raise ValueError("issued_at must not be after start")
    return {k: event[k] for k in KEYS}


def _ask(model, text):
    reply = bedrock.converse(model, PROMPT, [{"role": "user", "content": [{"text": text}]}],
                             tools=TOOLS, tool_choice="record_event")
    return reply["tool_uses"]


def parse_notice(notice_text: str) -> dict:
    """Event JSON (contracts/schemas/event.schema.json) from the notice; Bedrock errors propagate."""
    model = os.getenv("BEDROCK_MODEL_FAST")
    if not model:
        raise RuntimeError("BEDROCK_MODEL_FAST is not set")
    prompt = f"<notice>\n{notice_text}\n</notice>"
    try:
        event = _validate(_ask(model, prompt))
    except ValueError as error:
        # One fresh call, no sleep: the router gives parse 20 s in total.
        event = _validate(_ask(model, f"{prompt}\n\nYour previous record_event call failed validation: {error}. "
                                      "Call record_event again with the problem fixed."))
    return {**event, "source_text": notice_text}
