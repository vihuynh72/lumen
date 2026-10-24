"""Warm up the deployed backend, or run the whole demo flow against it. Standard library only.

Usage (from the repo root, DEMO_KEY set; LUMEN_URL set or AWS CLI credentials for the team account):
  python scripts/demo_check.py warmup        GET /state, one throwaway alert + plan, then reset
  python scripts/demo_check.py run [N]       N full demo runs (reset, alert, plan, approve, confirm, voice, re-plan), then reset
Exit 1 on the first failed step.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVENT = "PSPS-DEMO-01"
REPLAN = "DaVita Folsom Dialysis can only take four more"


def function_url():
    url = os.environ.get("LUMEN_URL") or subprocess.run(
        ["aws", "lambda", "get-function-url-config", "--region", os.environ.get("AWS_REGION", "us-east-2"),
         "--function-name", "lumen-api", "--query", "FunctionUrl", "--output", "text"],
        capture_output=True, text=True, check=True).stdout.strip()
    return url.rstrip("/") + "/"


def call(url, method, path, body=None):
    req = urllib.request.Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"x-demo-key": os.environ["DEMO_KEY"], "content-type": "application/json"})
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=125) as resp:
            status, data = resp.status, json.load(resp)
    except urllib.error.HTTPError as exc:
        status, data = exc.code, json.load(exc)
    ms = round((time.perf_counter() - start) * 1000)
    if status != 200:
        sys.exit(f"FAIL {method} /{path}: {status} {data}")
    return data, ms


def step(name, ms, detail=""):
    print(f"  {name:<10} {ms:>6} ms  {detail}")


def warmup(url):
    state, ms = call(url, "GET", "state")
    step("state", ms, f"version {state['version']}")
    _, ms = call(url, "POST", "alert", {"notice_text": (ROOT / "data/seed/notice.txt").read_text()})
    step("alert", ms)
    plan, ms = call(url, "POST", "plan", {"event_id": EVENT})
    step("plan", ms, f"{len(plan['patients'])} rows")
    body, ms = call(url, "POST", "reset")
    step("reset", ms, f"deleted {body['deleted']}")


def full_run(url):
    call(url, "POST", "reset")
    event, ms = call(url, "POST", "alert", {"notice_text": (ROOT / "data/seed/notice.txt").read_text()})
    step("alert", ms, f"{event['event_id']} parse_source={event.get('parse_source')}")
    plan, ms = call(url, "POST", "plan", {"event_id": EVENT})
    step("plan", ms, plan["summary"])
    plan, ms = call(url, "POST", "approve", {"event_id": EVENT, "patient_ids": ["all"], "edits": []})
    step("approve", ms, f"v{plan['version']}")
    row = next(r for r in plan["patients"] if r["action"] == "transfer" and r["clinic_id"] == "C02" and r["messages"])
    lang = next((lang for lang in (os.environ.get("VOICE_LANG"), "es", "zh", "en") if lang in row["messages"]), "en")
    plan, ms = call(url, "POST", "approve", {"event_id": EVENT, "patient_ids": [], "edits": [{"patient_id": row["patient_id"], "status": "confirmed"}]})
    step("confirm", ms, f"{row['patient_id']} v{plan['version']}")
    voice, ms = call(url, "POST", "voice", {"event_id": EVENT, "patient_id": row["patient_id"], "lang": lang})
    with urllib.request.urlopen(voice["url"], timeout=60) as resp:
        size, kind = len(resp.read()), resp.headers.get("content-type")
    if kind != "audio/mpeg" or size < 1000:
        sys.exit(f"FAIL voice MP3: {kind}, {size} bytes")
    step("voice", ms, f"{lang} MP3 {size} bytes")
    replan, ms = call(url, "POST", "replan", {"event_id": EVENT, "instruction": REPLAN})
    moved = len({d["patient_id"] for d in replan["diff"]})
    if not moved:
        sys.exit("FAIL replan: empty diff")
    step("replan", ms, f"v{replan['plan']['version']}, {moved} rows changed")
    state, ms = call(url, "GET", "state")
    step("state", ms, f"version {state['version']}, plan v{state['plan']['version']}")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "warmup"
    url = function_url()
    if mode == "warmup":
        warmup(url)
    elif mode == "run":
        for i in range(int(sys.argv[2]) if len(sys.argv) > 2 else 1):
            print(f"run {i + 1}")
            full_run(url)
        call(url, "POST", "reset")
    else:
        sys.exit(__doc__)
    print("OK")


if __name__ == "__main__":
    main()
