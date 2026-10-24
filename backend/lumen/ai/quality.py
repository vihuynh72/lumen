"""Quality runs against the deployed app: python -m lumen.ai.quality (from backend/).

Needs LUMEN_URL and DEMO_KEY in the environment. Each run resets the SHARED demo state, so tell the team first.
Token counts come from CloudWatch (README query), not from this tool.
"""

import argparse
import json
import os
from pathlib import Path
import re
import statistics
import sys
import time
import unicodedata
import urllib.error
import urllib.request

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[3]
NOTICE = (ROOT / "data" / "seed" / "notice.txt").read_text()
PLAN_SCHEMA = json.loads((ROOT / "contracts" / "schemas" / "plan.schema.json").read_text())
EVENT_ID = "PSPS-DEMO-01"
MOVES = ("early_session", "transfer")
STEPS = ("reset", "alert", "plan", "replan", "state")
DEFECTS = ("invented", "schema", "messages", "coverage")
CJK = re.compile(r"[㐀-鿿]")
LATIN_SENTENCE = re.compile(r"(?:[A-Za-z][A-Za-z'’-]*\s+){2,}[A-Za-z][A-Za-z'’-]*")
BANNED = re.compile(r"\b(?:death\w*|dead\w*|die|dies|died|dying|danger\w*|risk\w*|fatal\w*|lethal\w*|mortal\w*|"
                    r"muert\w*|muer\w*|murio|morir\w*|fallec\w*|pelig\w*|riesg\w*)\b|死|亡|危险|危險|风险|風險|致命|丧命|喪命")
SPANISH = set("su de la el le los las por en tratamiento dialisis sesion cita salga casa recoge recogera transporte "
              "favor llame preguntas hora llegue programado cambio y al un una para".split())


def _plain(text):
    return "".join(c for c in unicodedata.normalize("NFKD", text.casefold()) if not unicodedata.combining(c))


# Checks: each takes one plan (as the HTTP response shows it, names filled in) and returns a count.

def check_ids(plan, diff, known):
    """IDs in the plan rows, overflow and diff that /state does not know."""
    seen = [row["patient_id"] for row in plan["patients"]] + list(plan["overflow"]) + [d["patient_id"] for d in diff]
    seen += [row["clinic_id"] for row in plan["patients"] if row.get("clinic_id")]
    seen += [d[side] for d in diff if d["field"] == "clinic_id" for side in ("from", "to") if d[side]]
    return sum(1 for value in seen if value not in known)


def check_schema(plan):
    return sum(1 for _ in Draft202012Validator(PLAN_SCHEMA).iter_errors(plan))


def _message_problem(text, lang, name, state):
    if "{name}" in text:
        return True
    without_name = text.replace(name, "") if name else text
    if (len(without_name.strip()) > 80) if lang == "zh" else (len(without_name.split()) > 40):
        return True
    if BANNED.search(_plain(text)):
        return True
    local = without_name
    for clinic in state["clinics"]:
        for part in (clinic["name"], clinic["address"], clinic["address"].split(",")[0]):
            local = local.replace(part, "")
    if lang == "zh":
        return not CJK.search(local) or bool(LATIN_SENTENCE.search(local))
    if CJK.search(local):
        return True
    return lang == "es" and len(SPANISH & set(re.findall(r"[^\W\d_]+", _plain(local)))) < 2


def check_messages(plan, state):
    """Messages that are too long, keep a placeholder, hold a banned word or are in the wrong language."""
    names = {p["id"]: p["name"] for p in state["patients"]}
    return sum(_message_problem(text, lang, names.get(row["patient_id"], ""), state)
               for row in plan["patients"] for lang, text in row["messages"].items())


def check_coverage(plan, state):
    """Moving rows whose message languages are not exactly English plus the patient's own language."""
    langs = {p["id"]: p["language"] for p in state["patients"]}
    bad = 0
    for row in plan["patients"]:
        if row["action"] in MOVES:
            wanted = {"en", langs.get(row["patient_id"], "en")}
            bad += set(row["messages"]) != wanted
    return bad


# HTTP

def make_call(url, key):
    """call(method, path, body) -> (status, data, seconds). Status 0 means no HTTP answer."""
    base = url.rstrip("/") + "/"

    def call(method, path, body=None):
        req = urllib.request.Request(
            base + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"x-demo-key": key, "content-type": "application/json"})
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=125) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
        except (urllib.error.URLError, OSError) as error:
            return 0, {"error": str(error)}, time.perf_counter() - start
        try:
            data = json.loads(raw)
        except ValueError:
            data = {"error": "response was not JSON"}
        return status, data, time.perf_counter() - start
    return call


# One run, the summary and the report

def run_once(call, clinic):
    statuses, data, seconds = {}, {}, {}
    bodies = {"reset": ("POST", None), "alert": ("POST", {"notice_text": NOTICE}),
              "plan": ("POST", {"event_id": EVENT_ID}),
              "replan": ("POST", {"event_id": EVENT_ID, "instruction": f"{clinic} can only take four more"}),
              "state": ("GET", None)}
    for step in STEPS:
        method, body = bodies[step]
        statuses[step], data[step], seconds[step] = call(method, step, body)
    ok = {step: statuses[step] == 200 and isinstance(data[step], dict) for step in STEPS}
    plan1 = data["plan"] if ok["plan"] else None
    replan = data["replan"] if ok["replan"] else None
    plan2 = replan["plan"] if replan else None
    state = data["state"] if ok["state"] else None
    run = {"statuses": statuses, "plan_s": seconds["plan"] if ok["plan"] else None,
           "replan_s": seconds["replan"] if ok["replan"] else None,
           "parse": data["alert"].get("parse_source") if ok["alert"] else None,
           "text": (plan1.get("ai_sources") or {}).get("text") if plan1 else None,
           "replan": (plan2.get("ai_sources") or {}).get("replan") if plan2 else None,
           "replan_text": (plan2.get("ai_sources") or {}).get("text") if plan2 else None,
           "event_id": data["alert"].get("event_id") if ok["alert"] else None,
           "plan_version": plan2["version"] if plan2 else None, **dict.fromkeys(DEFECTS, 0)}
    if state:
        known = {p["id"] for p in state["patients"]} | {c["id"] for c in state["clinics"]}
        for plan, diff in ((plan1, []), (plan2, replan["diff"] if replan else [])):
            if plan:
                run["invented"] += check_ids(plan, diff, known)
                run["schema"] += check_schema(plan)
                run["messages"] += check_messages(plan, state)
                run["coverage"] += check_coverage(plan, state)
    run["clean"] = all(ok.values()) and not any(run[k] for k in DEFECTS)
    return run


def _sources(runs, keys):
    counts = {"bedrock": 0, "fallback": 0, "unknown": 0}
    for run in runs:
        for key in keys:
            counts[run[key] if run[key] in counts else "unknown"] += 1
    return {k: v for k, v in counts.items() if v or k != "unknown"}


def summarize(runs):
    def spread(key):
        values = [r[key] for r in runs if r[key] is not None]
        return (statistics.median(values), max(values)) if values else (None, None)
    streak = 0
    for run in reversed(runs):
        if not run["clean"]:
            break
        streak += 1
    all_bedrock = [r for r in runs if r["clean"] and (r["parse"], r["text"], r["replan"], r["replan_text"]) == ("bedrock",) * 4]
    plan_median, plan_max = spread("plan_s")
    replan_median, replan_max = spread("replan_s")
    return {"runs": len(runs), "clean": sum(r["clean"] for r in runs), "streak": streak,
            "plan_median": plan_median, "plan_max": plan_max, "replan_median": replan_median, "replan_max": replan_max,
            "parse": _sources(runs, ("parse",)), "text": _sources(runs, ("text", "replan_text")),
            "replan": _sources(runs, ("replan",)),
            "best": min(all_bedrock, key=lambda r: r["plan_s"] + r["replan_s"], default=None)}


def render_table(runs):
    def cell(value, spec="{}"):
        return "-" if value is None else spec.format(value)
    head = ["run", "HTTP reset/alert/plan/replan/state", "parse", "text plan/replan", "replan", "plan s", "replan s",
            "invented IDs", "schema", "messages", "coverage", "clean"]
    lines = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    for run in runs:
        row = [cell(run.get("n")), "/".join(str(run["statuses"][s]) for s in STEPS), cell(run["parse"]),
               f"{cell(run['text'])}/{cell(run['replan_text'])}", cell(run["replan"]),
               cell(run["plan_s"], "{:.1f}"), cell(run["replan_s"], "{:.1f}"),
               *(str(run[k]) for k in DEFECTS), "yes" if run["clean"] else "no"]
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def render_summary(s):
    def seconds(value):
        return "-" if value is None else f"{value:.1f} s"

    def split(counts):
        return ", ".join(f"{n} {k}" for k, n in counts.items())
    best = s["best"]
    return "\n".join([
        f"Clean runs: {s['clean']} of {s['runs']}. Clean streak at the end: {s['streak']}.",
        f"/plan seconds: median {seconds(s['plan_median'])}, max {seconds(s['plan_max'])}.",
        f"/replan seconds: median {seconds(s['replan_median'])}, max {seconds(s['replan_max'])}.",
        f"Steps from Bedrock vs fallback: parse {split(s['parse'])}; text {split(s['text'])} "
        f"(plan and re-plan); re-plan {split(s['replan'])}.",
        "No clean run came entirely from Bedrock." if best is None else
        f"Best clean all-Bedrock run (fastest): run {best.get('n', '-')}, event_id {best['event_id']}, "
        f"plan v{best['plan_version']}.",
        "Token counts come from CloudWatch (README query), not this tool.",
    ])


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m lumen.ai.quality", description=__doc__.split("\n\n")[0])
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--clinic", default="DaVita Folsom Dialysis")
    args = parser.parse_args(argv)
    url, key = os.environ.get("LUMEN_URL"), os.environ.get("DEMO_KEY")
    for name, value in (("LUMEN_URL", url), ("DEMO_KEY", key)):
        if not value:
            sys.exit(f"{name} is not set. Export LUMEN_URL (the function URL) and DEMO_KEY, then run again.")
    print("WARNING: POST /reset clears the SHARED demo state (plans and audio for the demo event). "
          "Tell the team before running. The state is reset again at the end.", flush=True)
    call, runs = make_call(url, key), []
    try:
        for n in range(1, args.runs + 1):
            runs.append({**run_once(call, args.clinic), "n": n})
            print(f"run {n}/{args.runs} done", file=sys.stderr, flush=True)
    finally:
        call("POST", "reset")
    print(render_table(runs))
    print()
    print(render_summary(summarize(runs)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
