"""Small Converse adapter; callers supply prompts and Converse content blocks."""

import json
import logging
import os
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from time import perf_counter, sleep

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ParamValidationError


logger = logging.getLogger(__name__)
_attempt_guard = ContextVar("bedrock_attempt_guard", default=None)
# Imported models take invoke_model bodies: "messages" (OpenAI chat) or "prompt" (Qwen ChatML).
IMPORTED_FORMAT = os.getenv("BEDROCK_IMPORTED_FORMAT", "messages")
IMPORTED_MAX_TOKENS = 4096


@contextmanager
def attempt_guard(callback):
    """Scope a caller's budget check to each service attempt in this context."""
    token = _attempt_guard.set(callback)
    try:
        yield
    finally:
        _attempt_guard.reset(token)


def _check_attempt():
    if (guard := _attempt_guard.get()) is not None:
        guard()


@lru_cache(maxsize=1)
def _get_client():
    """Defer credentials/region resolution until the first call; reuse the client."""
    return boto3.client(
        "bedrock-runtime",
        region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        # The adapter owns retries, including when AWS_MAX_ATTEMPTS is set.
        config=Config(
            retries={"mode": "standard", "total_max_attempts": 1},
            connect_timeout=5,
            read_timeout=20,
        ),
    )


def _invoke(client, request):
    _check_attempt()
    try:
        return client.converse(**request)
    except ClientError as error:
        if error.response["Error"]["Code"] not in (
            "ThrottlingException", "ServiceUnavailableException",
            "InternalServerException", "ModelNotReadyException",
        ):
            raise
        sleep(0.25)
        _check_attempt()
        return client.converse(**request)


def _invoke_imported(client, request):
    _check_attempt()
    try:
        return client.invoke_model(**request)
    except ClientError as error:
        code = error.response["Error"]["Code"]
        if code not in (
            "ThrottlingException", "ServiceUnavailableException",
            "InternalServerException", "ModelNotReadyException",
        ):
            raise
        # An idle imported model cold-starts; AWS asks callers to wait and retry.
        sleep(3 if code == "ModelNotReadyException" else 0.25)
        _check_attempt()
        return client.invoke_model(**request)


def _imported_chat(system, messages, tools, tool_choice):
    """Converse request as plain chat turns; tool use is emulated with JSON replies."""
    specs = {tool["toolSpec"]["name"]: tool["toolSpec"] for tool in tools or []}
    if tool_choice is not None:
        system += (f"\n\nAnswer by calling the tool {tool_choice}. Reply with ONLY one JSON object that "
                   f"matches this JSON schema: {json.dumps(specs[tool_choice]['inputSchema']['json'])}. "
                   "No prose, no code fences.")
    elif specs:
        listing = "\n".join(f"- {name}: {spec['description']} Input schema: {json.dumps(spec['inputSchema']['json'])}"
                            for name, spec in specs.items())
        system += (f"\n\nTools:\n{listing}\n\nTo call a tool, reply with ONLY one JSON object "
                   '{"tool": "<name>", "input": {...}}. When you are done, reply with ONLY {"final": "<text>"}. '
                   "No prose, no code fences.")
    names, chat = {}, [{"role": "system", "content": system}]
    for message in messages:
        parts = []
        for block in message["content"]:
            if "text" in block:
                parts.append(block["text"])
            elif (use := block.get("toolUse")) is not None:
                names[use["toolUseId"]] = use["name"]
                parts.append(json.dumps({"tool": use["name"], "input": use["input"]}))
            else:
                result = block["toolResult"]
                parts.append(f"Result of {names[result['toolUseId']]} ({result['toolUseId']}): "
                             f"{json.dumps(result['content'])}")
        chat.append({"role": message["role"], "content": "\n".join(parts)})
    return chat


def _first_object(text):
    """First balanced JSON object; skips prose and code fences before it."""
    try:
        value, _ = json.JSONDecoder().raw_decode(text, text.index("{"))
    except ValueError:
        raise ValueError("imported model reply is not a JSON object") from None
    if not isinstance(value, dict):
        raise ValueError("imported model reply is not a JSON object")
    return value


def _converse_imported(model_id, system, messages, tools, tool_choice):
    chat = _imported_chat(system, messages, tools, tool_choice)
    if IMPORTED_FORMAT == "prompt":
        prompt = "".join(f"<|im_start|>{turn['role']}\n{turn['content']}<|im_end|>\n" for turn in chat)
        body = {"prompt": prompt + "<|im_start|>assistant\n", "max_gen_len": IMPORTED_MAX_TOKENS, "temperature": 0}
    else:
        body = {"messages": chat, "max_tokens": IMPORTED_MAX_TOKENS, "temperature": 0}
    request = {"modelId": model_id, "body": json.dumps(body),
               "contentType": "application/json", "accept": "application/json"}
    reply = json.loads(_invoke_imported(_get_client(), request)["body"].read())
    choice = (reply.get("choices") or reply.get("outputs") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or choice.get("text") or reply.get("generation")
    if not isinstance(text, str):
        raise ValueError("imported model returned no text")
    counts = reply.get("usage") or {}
    usage = {"input_tokens": counts.get("prompt_tokens", reply.get("prompt_token_count", len(request["body"]) // 4)),
             "output_tokens": counts.get("completion_tokens", reply.get("generation_token_count", len(text) // 4))}
    stop, call = "end_turn", None
    if (choice.get("finish_reason") or reply.get("stop_reason")) == "length":
        stop = "max_tokens"  # Truncated JSON; text.py splits its batch on this, as with Converse.
    elif tool_choice is not None:
        call = (tool_choice, _first_object(text))
    elif tools and "{" in text:
        value = _first_object(text)
        if isinstance(value.get("tool"), str):
            call = (value["tool"], value.get("input", {}))
        elif isinstance(value.get("final"), str):
            text = value["final"]
        else:
            raise ValueError("imported model reply has neither tool nor final")
    if call is None:
        return {"stop_reason": stop, "text": text, "tool_uses": [], "usage": usage,
                "message": {"role": "assistant", "content": [{"text": text}]}}
    # Unique within the conversation so each toolResult maps back to its call.
    use_id = f"imp-{sum('toolUse' in block for m in messages for block in m['content']) + 1}"
    name, tool_input = call
    return {"stop_reason": "tool_use", "text": "",
            "tool_uses": [{"id": use_id, "name": name, "input": tool_input}], "usage": usage,
            "message": {"role": "assistant", "content": [
                {"toolUse": {"toolUseId": use_id, "name": name, "input": tool_input}}]}}


def converse(model_id: str, system: str, messages: list, tools: list | None = None,
             tool_choice: str | None = None) -> dict:
    """Return normalized output plus the unmodified assistant message.

    ``system`` is plain text; messages and tools use Converse format. A tool
    name forces that tool; None selects auto. Log one metrics line per wrapper
    call (including retry time); token counts are None when AWS returns no usage.
    A response with no usage raises KeyError.
    """
    started = perf_counter()
    usage = {"input_tokens": None, "output_tokens": None}
    try:
        if tool_choice is not None and not tools:
            raise ValueError("tool_choice requires tools")
        if ":imported-model/" in model_id:
            # Custom Model Import has no Converse toolConfig; tool use is emulated.
            result = _converse_imported(model_id, system, messages, tools, tool_choice)
            usage = result["usage"]
            return result
        request = {"modelId": model_id, "system": [{"text": system}], "messages": messages}
        if tools:
            request = {**request, "toolConfig": {
                "tools": tools,
                "toolChoice": {"auto": {}} if tool_choice is None else {
                    "tool": {"name": tool_choice},
                },
            }}
        response = _invoke(_get_client(), request)
        usage = {"input_tokens": response["usage"]["inputTokens"],
                 "output_tokens": response["usage"]["outputTokens"]}
        message = response["output"]["message"]
        return {
            "stop_reason": response["stopReason"],
            "text": "".join(block["text"] for block in message["content"] if "text" in block),
            "tool_uses": [
                {"id": tool["toolUseId"], "name": tool["name"], "input": tool["input"]}
                for block in message["content"] if (tool := block.get("toolUse")) is not None
            ],
            "usage": usage,
            "message": message,
        }
    except ParamValidationError:
        # Raise outside the handler so sensitive details aren't retained as context.
        pass
    finally:
        logger.info(
            "bedrock model_id=%r input_tokens=%s output_tokens=%s milliseconds=%.1f",
            model_id, usage["input_tokens"], usage["output_tokens"],
            (perf_counter() - started) * 1000,
        )
    raise ValueError("invalid Converse request") from None
