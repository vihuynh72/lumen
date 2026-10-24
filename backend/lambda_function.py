import json


def lambda_handler(event, context):
    # Stub: the router lands in VI-181.
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"ok": True}),
    }
