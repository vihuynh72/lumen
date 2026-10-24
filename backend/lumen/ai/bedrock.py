"""Small Converse adapter; callers supply prompts and Converse content blocks."""

import logging
import os
from functools import lru_cache
from time import perf_counter, sleep

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ParamValidationError


logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _get_client():
    """Defer credentials/region resolution until the first call; reuse the client."""
    return boto3.client(
        "bedrock-runtime",
        region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        # The adapter owns retries, including when AWS_MAX_ATTEMPTS is set.
        config=Config(retries={"mode": "standard", "total_max_attempts": 1}),
    )


def _invoke(client, request):
    try:
        return client.converse(**request)
    except ClientError as error:
        if error.response["Error"]["Code"] not in (
            "ThrottlingException", "ServiceUnavailableException",
            "InternalServerException", "ModelNotReadyException",
        ):
            raise
        sleep(0.25)
        return client.converse(**request)


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
