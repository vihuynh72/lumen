"""S3 storage: seed files, events and plan versions (master plan section 6)."""

import json
import os
import re

SEED_FILES = {"clinics": "clinics.json", "patients": "patients.json", "outage_area": "outage_area.geojson", "rules": "rules.json"}
_client = None


def s3():
    global _client
    if _client is None:
        import boto3  # in the Lambda runtime; tests swap in a fake client
        from botocore.config import Config
        region = os.environ.get("AWS_REGION", "us-east-2")
        # Regional endpoint: presigned URLs on the global host are signed for the wrong region and return 400.
        _client = boto3.client("s3", region_name=region, endpoint_url=f"https://s3.{region}.amazonaws.com",
                               config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
    return _client


def bucket():
    return os.environ["BUCKET"]


def get_json(key):
    """The object at key as JSON, or None when it does not exist."""
    try:
        body = s3().get_object(Bucket=bucket(), Key=key)["Body"].read()
    except Exception as exc:  # botocore ClientError; boto3 is not imported here
        if getattr(exc, "response", {}).get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise
    return json.loads(body)


class VersionTaken(Exception):
    """Another request already wrote this plan version."""


def put_json(key, data, if_none_match=False):
    extra = {"IfNoneMatch": "*"} if if_none_match else {}  # S3 conditional write: fail if the key exists
    try:
        s3().put_object(Bucket=bucket(), Key=key, Body=json.dumps(data, ensure_ascii=False).encode(), ContentType="application/json", **extra)
    except Exception as exc:
        if if_none_match and getattr(exc, "response", {}).get("Error", {}).get("Code") in ("PreconditionFailed", "ConditionalRequestConflict"):
            raise VersionTaken(key) from exc
        raise


def list_objects(prefix):
    objects, token = [], None
    while True:
        kwargs = {"Bucket": bucket(), "Prefix": prefix, **({"ContinuationToken": token} if token else {})}
        page = s3().list_objects_v2(**kwargs)
        objects += page.get("Contents", [])
        if not page.get("IsTruncated"):
            return objects
        token = page["NextContinuationToken"]


def delete_keys(keys):
    for i in range(0, len(keys), 1000):
        s3().delete_objects(Bucket=bucket(), Delete={"Objects": [{"Key": k} for k in keys[i:i + 1000]], "Quiet": True})
    return len(keys)


def load_seed():
    seed = {name: get_json(f"seed/{file}") for name, file in SEED_FILES.items()}
    missing = [name for name, data in seed.items() if data is None]
    if missing:
        raise LookupError(f"seed files missing in S3: {missing}")
    return seed


def save_event(event):
    put_json(f"plans/{event['event_id']}/event.json", event)


def load_event(event_id):
    return get_json(f"plans/{event_id}/event.json")


def latest_event():
    events = [o for o in list_objects("plans/") if o["Key"].endswith("/event.json")]
    return get_json(max(events, key=lambda o: o["LastModified"])["Key"]) if events else None


def plan_versions(event_id):
    found = (re.search(r"/plan\.v(\d+)\.json$", o["Key"]) for o in list_objects(f"plans/{event_id}/plan.v"))
    return sorted(int(m.group(1)) for m in found if m)


def save_plan(plan, new=False):
    """new=True: refuse to overwrite an existing version (two edits on the same version)."""
    put_json(f"plans/{plan['event_id']}/plan.v{plan['version']}.json", plan, if_none_match=new)


def latest_plan(event_id):
    versions = plan_versions(event_id)
    return get_json(f"plans/{event_id}/plan.v{versions[-1]}.json") if versions else None


def delete_plans(event_id):
    """Delete every plan version of an event (a new POST /plan starts again at v1)."""
    return delete_keys([f"plans/{event_id}/plan.v{v}.json" for v in plan_versions(event_id)])


def reset():
    """Delete everything under plans/ and audio/. Seed files stay."""
    return delete_keys([o["Key"] for prefix in ("plans/", "audio/") for o in list_objects(prefix)])
