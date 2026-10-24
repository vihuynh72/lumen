"""Offline checks against botocore's actual Converse service model."""

import importlib
import io
import json
import logging
import traceback
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber

from lumen.ai import bedrock


MODEL = "test-model"
SYSTEM = "private system instructions"
MESSAGES = [{"role": "user", "content": [{"text": "private prompt"}]}]
TOOLS = [{"toolSpec": {
    "name": "lookup", "description": "private tool description",
    "inputSchema": {"json": {"type": "object", "properties": {}}},
}}]
REQUEST = {"modelId": MODEL, "system": [{"text": SYSTEM}], "messages": MESSAGES}
TRANSIENT_CODES = [
    "ThrottlingException", "ServiceUnavailableException",
    "InternalServerException", "ModelNotReadyException",
]


def response(content=None, stop_reason="end_turn"):
    return {
        "output": {"message": {"role": "assistant", "content": content or [
            {"text": "Hello "}, {"text": "there!"},
        ]}},
        "stopReason": stop_reason,
        "usage": {"inputTokens": 11, "outputTokens": 7, "totalTokens": 18},
        "metrics": {"latencyMs": 10},
    }


@pytest.fixture
def client(monkeypatch):
    client = boto3.client(
        "bedrock-runtime", region_name="us-west-2",
        aws_access_key_id="testing", aws_secret_access_key="testing",
    )
    monkeypatch.setattr(bedrock, "_get_client", lambda: client)
    try:
        yield client
    finally:
        client.close()


@pytest.fixture
def stub(client):
    with Stubber(client) as stubber:
        yield stubber
        stubber.assert_no_pending_responses()


@pytest.fixture
def sleep(monkeypatch):
    pause = Mock()
    monkeypatch.setattr(bedrock, "sleep", pause)
    return pause


def test_text_reply(stub):
    reply = response()
    before = deepcopy(REQUEST)
    stub.add_response("converse", reply, REQUEST)
    assert bedrock.converse(MODEL, SYSTEM, MESSAGES) == {
        "stop_reason": "end_turn", "text": "Hello there!", "tool_uses": [],
        "usage": {"input_tokens": 11, "output_tokens": 7},
        "message": reply["output"]["message"],
    }
    assert REQUEST == before


def test_parameter_validation_does_not_leak_content(client, sleep, caplog):
    caplog.set_level(logging.INFO, logger=bedrock.__name__)
    invalid_system = [{"text": "P001 Rosa lives at 38.73,-120.79"}]
    with Stubber(client) as stubber:
        # Serialization fails before Stubber consumes this response.
        stubber.add_response("converse", response(), {
            **REQUEST, "system": [{"text": invalid_system}],
        })
        with pytest.raises(ValueError, match="^invalid Converse request$") as caught:
            bedrock.converse(MODEL, invalid_system, MESSAGES)
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None
    error_text = "".join(traceback.format_exception(caught.value))
    for content in ("P001", "Rosa", "38.73", "-120.79", "private prompt"):
        assert content not in error_text
        assert content not in caplog.text
    sleep.assert_not_called()
    assert len(caplog.records) == 1


@pytest.mark.parametrize("tool_choice", [None, "lookup"])
def test_tool_reply_and_choice(stub, tool_choice):
    content = [
        {"text": "Looking up."},
        {"toolUse": {"toolUseId": "call-1", "name": "lookup", "input": {"id": "P001"}}},
        {"toolUse": {"toolUseId": "call-2", "name": "lookup", "input": {"id": "P002"}}},
    ]
    reply = response(content, "tool_use")
    choice = {"tool": {"name": "lookup"}} if tool_choice else {"auto": {}}
    stub.add_response("converse", reply, {
        **REQUEST, "toolConfig": {"tools": TOOLS, "toolChoice": choice},
    })
    result = bedrock.converse(MODEL, SYSTEM, MESSAGES, TOOLS, tool_choice)
    assert result == {
        "stop_reason": "tool_use", "text": "Looking up.",
        "tool_uses": [
            {"id": "call-1", "name": "lookup", "input": {"id": "P001"}},
            {"id": "call-2", "name": "lookup", "input": {"id": "P002"}},
        ],
        "usage": {"input_tokens": 11, "output_tokens": 7},
        "message": reply["output"]["message"],
    }
    followup = [*MESSAGES, result["message"], {"role": "user", "content": [
        {"toolResult": {"toolUseId": "call-1", "content": [{"text": "found"}]}},
        {"toolResult": {"toolUseId": "call-2", "content": [{"text": "found"}]}},
    ]}]
    stub.add_response("converse", response(), {**REQUEST, "messages": followup})
    assert bedrock.converse(MODEL, SYSTEM, followup)["text"] == "Hello there!"


def test_tool_only_reply(stub):
    reply = response([{"toolUse": {
        "toolUseId": "call-1", "name": "lookup", "input": {},
    }}], "tool_use")
    stub.add_response("converse", reply, {
        **REQUEST, "toolConfig": {"tools": TOOLS, "toolChoice": {"auto": {}}},
    })
    assert bedrock.converse(MODEL, SYSTEM, MESSAGES, TOOLS)["text"] == ""


@pytest.mark.parametrize("code", TRANSIENT_CODES)
def test_transient_error_then_success(stub, sleep, caplog, code):
    caplog.set_level(logging.INFO, logger=bedrock.__name__)
    stub.add_client_error("converse", code, expected_params=REQUEST)
    stub.add_response("converse", response(), REQUEST)
    assert bedrock.converse(MODEL, SYSTEM, MESSAGES)["text"] == "Hello there!"
    sleep.assert_called_once_with(0.25)
    assert len(caplog.records) == 1


@pytest.mark.parametrize("code", ["ValidationException", "AccessDeniedException"])
def test_permanent_error_not_retried(stub, sleep, caplog, code):
    caplog.set_level(logging.INFO, logger=bedrock.__name__)
    stub.add_client_error("converse", code, "private service error", expected_params=REQUEST)
    with pytest.raises(ClientError) as caught:
        bedrock.converse(MODEL, SYSTEM, MESSAGES)
    assert caught.value.response["Error"]["Code"] == code
    sleep.assert_not_called()
    assert len(caplog.records) == 1
    assert "input_tokens=None output_tokens=None" in caplog.text
    assert "private" not in caplog.text


@pytest.mark.parametrize("code", TRANSIENT_CODES)
def test_second_transient_error_raises(stub, sleep, code):
    for message in ("first failure", "second failure"):
        stub.add_client_error("converse", code, message, expected_params=REQUEST)
    with pytest.raises(ClientError) as caught:
        bedrock.converse(MODEL, SYSTEM, MESSAGES)
    assert caught.value.response["Error"]["Code"] == code
    assert caught.value.response["Error"]["Message"] == "second failure"
    sleep.assert_called_once_with(0.25)


def test_log_has_metrics_without_content(stub, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=bedrock.__name__)
    monkeypatch.setattr(bedrock, "perf_counter", Mock(side_effect=[100, 100.125]))
    stub.add_response("converse", response([{"text": "private response"}]), REQUEST)
    bedrock.converse(MODEL, SYSTEM, MESSAGES)
    assert len(caplog.records) == 1
    assert caplog.records[0].getMessage() == (
        "bedrock model_id='test-model' input_tokens=11 output_tokens=7 milliseconds=125.0"
    )
    assert "private" not in caplog.text


def test_forced_tool_requires_tools(stub):
    with pytest.raises(ValueError, match="tools"):
        bedrock.converse(MODEL, SYSTEM, MESSAGES, tool_choice="lookup")


def test_attempt_guard_checks_initial_and_retry_after_backoff(stub, sleep):
    events = []
    sleep.side_effect = lambda _: events.append("sleep")
    stub.add_client_error("converse", "ThrottlingException", expected_params=REQUEST)
    stub.add_response("converse", response(), REQUEST)
    with bedrock.attempt_guard(lambda: events.append("guard")):
        assert bedrock.converse(MODEL, SYSTEM, MESSAGES)["text"] == "Hello there!"
    assert events == ["guard", "sleep", "guard"]


def test_attempt_guard_denies_retry_after_backoff(stub, sleep):
    budget_error = RuntimeError("budget exhausted")
    guard = Mock(side_effect=[None, budget_error])
    stub.add_client_error("converse", "ThrottlingException", expected_params=REQUEST)
    with bedrock.attempt_guard(guard), pytest.raises(RuntimeError) as caught:
        bedrock.converse(MODEL, SYSTEM, MESSAGES)
    assert caught.value is budget_error
    assert guard.call_count == 2
    sleep.assert_called_once_with(0.25)


def test_attempt_guard_resets_after_nested_failure(stub):
    outer = Mock()
    inner_error = RuntimeError("inner budget exhausted")
    inner = Mock(side_effect=inner_error)
    for _ in range(3):
        stub.add_response("converse", response(), REQUEST)
    with bedrock.attempt_guard(outer):
        bedrock.converse(MODEL, SYSTEM, MESSAGES)
        with pytest.raises(RuntimeError) as caught:
            with bedrock.attempt_guard(inner):
                bedrock.converse(MODEL, SYSTEM, MESSAGES)
        assert caught.value is inner_error
        bedrock.converse(MODEL, SYSTEM, MESSAGES)
    bedrock.converse(MODEL, SYSTEM, MESSAGES)
    assert outer.call_count == 2
    inner.assert_called_once_with()


def test_attempt_guard_does_not_leak_to_another_thread(stub):
    guard = Mock(side_effect=RuntimeError("main thread exhausted"))
    stub.add_response("converse", response(), REQUEST)
    with bedrock.attempt_guard(guard):
        with ThreadPoolExecutor(max_workers=1) as pool:
            reply = pool.submit(bedrock.converse, MODEL, SYSTEM, MESSAGES).result(timeout=3)
        assert reply["text"] == "Hello there!"
        with pytest.raises(RuntimeError, match="main thread exhausted"):
            bedrock.converse(MODEL, SYSTEM, MESSAGES)
    guard.assert_called_once_with()


@pytest.mark.parametrize("region_variable", ["AWS_REGION", "AWS_DEFAULT_REGION"])
def test_lazy_client_uses_environment_and_disables_sdk_retries(monkeypatch, region_variable):
    factory = Mock()
    monkeypatch.setattr(boto3, "client", factory)
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
    monkeypatch.setenv(region_variable, "us-west-2")
    importlib.reload(bedrock)
    factory.assert_not_called()
    try:
        assert bedrock._get_client() is bedrock._get_client()
        factory.assert_called_once()
        assert factory.call_args.args == ("bedrock-runtime",)
        assert factory.call_args.kwargs["region_name"] == "us-west-2"
        assert factory.call_args.kwargs["config"].retries == {
            "mode": "standard", "total_max_attempts": 1,
        }
        assert factory.call_args.kwargs["config"].connect_timeout == 5
        assert factory.call_args.kwargs["config"].read_timeout == 20
    finally:
        bedrock._get_client.cache_clear()


IMPORTED = "arn:aws:bedrock:us-east-2:343602350823:imported-model/abc123"


class FakeRuntime:
    """Records invoke_model/converse calls; replies are dicts or ClientErrors, in order."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

    def _next(self, operation, request):
        self.calls.append((operation, request))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def invoke_model(self, **request):
        return {"body": io.BytesIO(json.dumps(self._next("invoke_model", request)).encode())}

    def converse(self, **request):
        return self._next("converse", request)

    def body(self, index=-1):
        return json.loads(self.calls[index][1]["body"])


def chat(content, finish="stop", usage=True):
    reply = {"choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                          "finish_reason": finish}]}
    return {**reply, "usage": {"prompt_tokens": 50, "completion_tokens": 9}} if usage else reply


def runtime(monkeypatch, *replies, fmt="messages"):
    fake = FakeRuntime(*replies)
    monkeypatch.setattr(bedrock, "_get_client", lambda: fake)
    monkeypatch.setattr(bedrock, "IMPORTED_FORMAT", fmt)
    return fake


def test_imported_forced_tool(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=bedrock.__name__)
    fake = runtime(monkeypatch, chat('{"id": "P001"}'))
    result = bedrock.converse(IMPORTED, SYSTEM, MESSAGES, TOOLS, "lookup")
    tool_use = {"toolUseId": "imp-1", "name": "lookup", "input": {"id": "P001"}}
    assert result == {
        "stop_reason": "tool_use", "text": "",
        "tool_uses": [{"id": "imp-1", "name": "lookup", "input": {"id": "P001"}}],
        "usage": {"input_tokens": 50, "output_tokens": 9},
        "message": {"role": "assistant", "content": [{"toolUse": tool_use}]},
    }
    operation, request = fake.calls[0]
    assert operation == "invoke_model" and request["modelId"] == IMPORTED
    body = fake.body()
    assert (body["max_tokens"], body["temperature"]) == (4096, 0)
    system, user = body["messages"]
    assert system["role"] == "system" and system["content"].startswith(SYSTEM)
    assert "Answer by calling the tool lookup" in system["content"]
    assert json.dumps(TOOLS[0]["toolSpec"]["inputSchema"]["json"]) in system["content"]
    assert user == {"role": "user", "content": "private prompt"}
    assert "input_tokens=50 output_tokens=9" in caplog.text and "private" not in caplog.text


@pytest.mark.parametrize("reply", [
    {"choices": [{"text": '```json\n{"id": "P001"}\n```'}]},
    {"generation": 'Sure:\n```\n{"id": "P001"}\n```', "stop_reason": "stop"},
    {"outputs": [{"text": '{"id": "P001"} trailing'}]},
])
def test_imported_prompt_format_and_fences(monkeypatch, reply):
    fake = runtime(monkeypatch, reply, fmt="prompt")
    result = bedrock.converse(IMPORTED, SYSTEM, MESSAGES, TOOLS, "lookup")
    assert result["tool_uses"] == [{"id": "imp-1", "name": "lookup", "input": {"id": "P001"}}]
    assert all(isinstance(n, int) and n > 0 for n in result["usage"].values())
    body = fake.body()
    assert body["max_gen_len"] == 4096 and body["temperature"] == 0
    assert body["prompt"].startswith(f"<|im_start|>system\n{SYSTEM}")
    assert body["prompt"].endswith(
        "<|im_end|>\n<|im_start|>user\nprivate prompt<|im_end|>\n<|im_start|>assistant\n")


def test_imported_agent_loop_tool_call(monkeypatch):
    fake = runtime(monkeypatch, chat('{"tool": "lookup", "input": {"id": "P002"}}'))
    result = bedrock.converse(IMPORTED, SYSTEM, MESSAGES, TOOLS, None)
    assert result["stop_reason"] == "tool_use"
    assert result["tool_uses"] == [{"id": "imp-1", "name": "lookup", "input": {"id": "P002"}}]
    system = fake.body()["messages"][0]["content"]
    assert "- lookup: private tool description Input schema:" in system
    assert '{"tool": "<name>", "input": {...}}' in system and '{"final": "<text>"}' in system


@pytest.mark.parametrize("content, text", [('{"final": "Done."}', "Done."), ("All set.", "All set.")])
def test_imported_final_text(monkeypatch, content, text):
    runtime(monkeypatch, chat(content))
    assert bedrock.converse(IMPORTED, SYSTEM, MESSAGES, TOOLS, None) == {
        "stop_reason": "end_turn", "text": text, "tool_uses": [],
        "usage": {"input_tokens": 50, "output_tokens": 9},
        "message": {"role": "assistant", "content": [{"text": text}]},
    }


def test_imported_without_tools_returns_raw_text(monkeypatch):
    fake = runtime(monkeypatch, chat("Hello {name}", usage=False))
    result = bedrock.converse(IMPORTED, SYSTEM, MESSAGES)
    assert (result["stop_reason"], result["text"]) == ("end_turn", "Hello {name}")
    assert result["usage"] == {"input_tokens": len(fake.calls[0][1]["body"]) // 4, "output_tokens": 3}
    assert fake.body()["messages"][0] == {"role": "system", "content": SYSTEM}


@pytest.mark.parametrize("tool_choice, content", [
    ("lookup", "I cannot help."), ("lookup", '{"id": '), ("lookup", "[1, 2]"),
    (None, '{"tool": "lookup", "input": '), (None, '{"other": 1}'),
])
def test_imported_invalid_json_raises(monkeypatch, tool_choice, content):
    runtime(monkeypatch, chat(content))
    with pytest.raises(ValueError):
        bedrock.converse(IMPORTED, SYSTEM, MESSAGES, TOOLS, tool_choice)


def test_imported_truncated_reply_is_max_tokens(monkeypatch):
    runtime(monkeypatch, chat('{"id": "P0', finish="length"))
    result = bedrock.converse(IMPORTED, SYSTEM, MESSAGES, TOOLS, "lookup")
    assert (result["stop_reason"], result["tool_uses"]) == ("max_tokens", [])


def test_imported_history_tool_blocks_become_text(monkeypatch):
    fake = runtime(monkeypatch, chat('{"tool": "lookup", "input": {"id": "P001"}}'), chat('{"final": "ok"}'))
    first = bedrock.converse(IMPORTED, SYSTEM, MESSAGES, TOOLS)
    history = [*MESSAGES, first["message"], {"role": "user", "content": [{"toolResult": {
        "toolUseId": "imp-1", "content": [{"json": {"found": True}}], "status": "success"}}]}]
    assert bedrock.converse(IMPORTED, SYSTEM, history, TOOLS)["text"] == "ok"
    assert fake.body()["messages"][1:] == [
        {"role": "user", "content": "private prompt"},
        {"role": "assistant", "content": '{"tool": "lookup", "input": {"id": "P001"}}'},
        {"role": "user", "content": 'Result of lookup (imp-1): [{"json": {"found": true}}]'},
    ]
    fake.replies.append(chat('{"tool": "lookup", "input": {}}'))
    assert bedrock.converse(IMPORTED, SYSTEM, history, TOOLS)["tool_uses"][0]["id"] == "imp-2"


def test_imported_cold_start_retries_after_three_seconds(monkeypatch, sleep):
    not_ready = ClientError({"Error": {"Code": "ModelNotReadyException", "Message": "warming"}}, "InvokeModel")
    fake = runtime(monkeypatch, not_ready, chat("hi"))
    assert bedrock.converse(IMPORTED, SYSTEM, MESSAGES)["text"] == "hi"
    sleep.assert_called_once_with(3)
    assert [operation for operation, _ in fake.calls] == ["invoke_model", "invoke_model"]


def test_foundation_model_still_uses_converse(monkeypatch):
    fake = runtime(monkeypatch, response())
    assert bedrock.converse(MODEL, SYSTEM, MESSAGES)["text"] == "Hello there!"
    assert fake.calls == [("converse", REQUEST)]
