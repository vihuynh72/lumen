"""Rule-based rank (master plan section 8.4). The router uses it only when lumen.ai.rank fails or has not landed."""

from datetime import datetime, timedelta


def rank_by_rules(affected, patients, rules, drive):
    """Same output as rank_patients (team rules, Rule 3): rows for affected patients, sorted by rank."""
    now = datetime.fromisoformat(affected["now"])
    sessions = {s["patient_id"]: s for s in affected["sessions"]}
    closed = set(affected["closed_clinic_ids"])
    rows = []
    for p in patients:
        s = sessions.get(p["id"])
        if not s:
            continue  # unaffected patients are not ranked; match gives them notify_only rows
        start = datetime.fromisoformat(s["start"])
        reasons = ["session_in_window"]
        reasons += ["session_within_36h"] if start - now <= timedelta(hours=36) else []
        reasons += [f for f in ("heart_failure", "missed_recently") if f in p["flags"]]
        reasons += ["paratransit"] if p["ride"] == "paratransit" else []
        reasons += ["home_in_outage"] if affected["home_in_outage"].get(p["id"]) else []
        reasons += ["no_car"] if p["ride"] != "self" else []
        reasons += ["lives_alone"] if p["lives_alone"] else []
        reasons += ["wheelchair"] if p["mobility"] == "wheelchair" else []
        reasons += ["limited_english"] if p["language"] != "en" else []
        urgency = sum(rules["urgency"].get(r, 0) for r in reasons)
        difficulty = sum(rules["difficulty"].get(r, 0) for r in reasons)
        # "the longer drive": the drive to the nearest clinic that stays open
        nearest = min((v["minutes"] for cid, v in drive[p["id"]].items() if cid not in closed), default=0)
        rows.append(({"patient_id": p["id"], "urgency": urgency, "difficulty": difficulty, "reasons": reasons},
                     (-urgency, -difficulty, start, -nearest)))
    rows.sort(key=lambda row: row[1])
    return [{**row, "rank": i} for i, (row, _) in enumerate(rows, 1)]
