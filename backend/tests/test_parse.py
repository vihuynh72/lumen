"""Offline parse_notice checks: converse is stubbed, nothing touches the network."""

import json
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

from lumen.ai import parse

ROOT = Path(__file__).resolve().parents[2]
NOTICE = (ROOT / "data" / "seed" / "notice.txt").read_text()
SHORT = (ROOT / "data" / "seed" / "notice_short.txt").read_text()
EVENT = json.loads((ROOT / "contracts" / "fixtures" / "event.json").read_text())
SCHEMA = json.loads((ROOT / "contracts" / "schemas" / "event.schema.json").read_text())
KEYS = SCHEMA["required"]
GOOD = {k: EVENT[k] for k in KEYS if k != "source_text"}
SHORT_GOOD = {**GOOD, "event_id": "PSPS-DEMO-02", "issued_at": "2026-10-27T14:00:00-07:00"}


class Stub:
    """Plays back tool inputs, one per converse call, and records the calls."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

    def __call__(self, model_id, system, messages, tools=None, tool_choice=None):
        self.calls.append({"model_id": model_id, "system": system, "messages": messages,
                           "tools": tools, "tool_choice": tool_choice})
        return {"tool_uses": [{"id": "t", "name": "record_event", "input": self.replies.pop(0)}]}


@pytest.fixture
def stub(monkeypatch):
    monkeypatch.setenv("BEDROCK_MODEL_FAST", "test-fast")

    def install(*replies):
        s = Stub(*replies)
        monkeypatch.setattr(parse.bedrock, "converse", s)
        return s
    return install


def test_seed_notice_equals_fixture(stub):
    s = stub(GOOD)
    assert parse.parse_notice(NOTICE) == EVENT
    assert len(s.calls) == 1
    call = s.calls[0]
    assert call["model_id"] == "test-fast" and call["tool_choice"] == "record_event"
    assert [t["toolSpec"]["name"] for t in call["tools"]] == ["record_event"]


def test_short_notice(stub):
    stub(SHORT_GOOD)
    out = parse.parse_notice(SHORT)
    assert out == {**SHORT_GOOD, "source_text": SHORT}


def test_extra_keys_dropped(stub):
    stub({**GOOD, "parse_source": "bedrock", "confidence": 0.9})
    assert set(parse.parse_notice(NOTICE)) == set(KEYS)


@pytest.mark.parametrize("bad", [
    {k: v for k, v in GOOD.items() if k != "area_name"},
    {**GOOD, "end": "2026-10-27T17:00:00-07:00"},
    {**GOOD, "notice_type": "alert"},
    {**GOOD, "start": "2026-10-27T18:00:00"},
    {**GOOD, "start": "not a time"},
    {**GOOD, "issued_at": "2026-10-27T19:00:00-07:00"},
], ids=["missing-key", "end-before-start", "bad-type", "no-offset", "unparseable", "issued-after-start"])
def test_bad_first_reply_retries_once_with_error(stub, bad):
    s = stub(bad, GOOD)
    assert parse.parse_notice(NOTICE) == EVENT
    assert len(s.calls) == 2
    first, second = (c["messages"][0]["content"][0]["text"] for c in s.calls)
    assert NOTICE in first and "validation" not in first.lower()
    assert NOTICE in second and "validation" in second.lower()


def test_two_bad_replies_raise_value_error(stub):
    bad = {**GOOD, "notice_type": "alert"}
    s = stub(bad, bad)
    with pytest.raises(ValueError, match="notice_type"):
        parse.parse_notice(NOTICE)
    assert len(s.calls) == 2


def test_missing_model_env_raises(stub, monkeypatch):
    s = stub(GOOD)
    monkeypatch.delenv("BEDROCK_MODEL_FAST")
    with pytest.raises(RuntimeError, match="BEDROCK_MODEL_FAST"):
        parse.parse_notice(NOTICE)
    assert not s.calls


def test_client_error_propagates_unchanged(monkeypatch):
    monkeypatch.setenv("BEDROCK_MODEL_FAST", "test-fast")
    error = ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "Converse")

    def boom(*args, **kwargs):
        raise error
    monkeypatch.setattr(parse.bedrock, "converse", boom)
    with pytest.raises(ClientError) as caught:
        parse.parse_notice(NOTICE)
    assert caught.value is error


def test_tool_schema_hides_router_fields_and_tracks_contract(stub):
    s = stub(GOOD)
    parse.parse_notice(NOTICE)
    schema = s.calls[0]["tools"][0]["toolSpec"]["inputSchema"]["json"]
    text = json.dumps(schema)
    for banned in ("$schema", "$id", "parse_source", "source_text", "$ref", "$defs"):
        assert banned not in text
    assert schema["additionalProperties"] is False
    assert schema["required"] == [k for k in KEYS if k != "source_text"]
    # the shipped copy (Lambda has no contracts/) must match the contract's properties
    for key, prop in schema["properties"].items():
        want = SCHEMA["properties"][key]
        if "$ref" in want:
            want = {**SCHEMA["$defs"]["timestamp"], **{k: v for k, v in want.items() if k != "$ref"}}
        assert {k: v for k, v in want.items() if k != "title"} == prop
