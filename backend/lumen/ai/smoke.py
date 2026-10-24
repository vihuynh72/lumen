"""Manual live check: run `python -m lumen.ai.smoke` from backend/."""

import logging
import os
import sys

from botocore.exceptions import BotoCoreError, ClientError

from lumen.ai.bedrock import converse


def main() -> int:
    model_id = os.getenv("BEDROCK_MODEL_ID", "").strip()
    if not model_id:
        print("Set BEDROCK_MODEL_ID to the team's model before running this smoke test.", file=sys.stderr)
        return 1
    logging.basicConfig(level=logging.INFO)
    try:
        result = converse(model_id, "Reply briefly.", [
            {"role": "user", "content": [{"text": "Say hello in one short sentence."}]},
        ])
    except ClientError as error:
        code = error.response["Error"]["Code"]
        if code == "AccessDeniedException":
            print("Bedrock access denied: check model access, AWS credentials, and region.", file=sys.stderr)
        else:
            print(f"Bedrock smoke test failed ({code}). Check BEDROCK_MODEL_ID and AWS setup.", file=sys.stderr)
        return 1
    except BotoCoreError as error:
        print(f"AWS setup/request failed ({type(error).__name__}). Check credentials and region.", file=sys.stderr)
        return 1
    if not result["text"].strip():
        print("Bedrock returned no text reply.", file=sys.stderr)
        return 1
    print(result["text"])
    print(f"Input tokens: {result['usage']['input_tokens']}; output tokens: {result['usage']['output_tokens']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
