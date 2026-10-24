"""Rule-based patient ranking (master plan section 8, step 4). Plain Python: no Bedrock call, no Backend imports."""

from datetime import datetime, timedelta

WITHIN_HOURS = 36


def _facts(patient: dict, home_in_outage: bool, starts_within_36h: bool) -> dict:
    """Which rules.json keys apply to this patient. Keys with no entry here never fire."""
    flags = patient["flags"]
    return {
        "session_in_window": True,  # only patients with an affected session are ranked
        "session_within_36h": starts_within_36h,
        "heart_failure": "heart_failure" in flags,
        "missed_recently": "missed_recently" in flags,
        "paratransit": patient["ride"] == "paratransit",
        "home_in_outage": home_in_outage,
        "no_car": patient["ride"] != "self",
        "lives_alone": bool(patient["lives_alone"]),
        "wheelchair": patient["mobility"] == "wheelchair",
        "limited_english": patient["language"] != "en",
    }


def _longest_open_drive(drive: dict | None, patient_id: str, closed: set) -> int:
    """Minutes to the nearest clinic that stays open; 0 when unknown (the drive key is then a no-op)."""
    options = (drive or {}).get(patient_id, {})
    return min((v["minutes"] for clinic_id, v in options.items() if clinic_id not in closed), default=0)


def rank_patients(affected: dict, patients: list, rules: dict, drive: dict | None = None) -> list:
    """Rank affected patients: urgency, then difficulty, then earlier session, then longer drive, then id.

    Returns [{"patient_id", "rank", "urgency", "difficulty", "reasons"}] sorted by rank (1-based). The final
    patient_id key makes the order independent of input order. Patients with no affected session are not ranked.
    """
    now = datetime.fromisoformat(affected["now"])
    closed = set(affected["closed_clinic_ids"])
    home = affected["home_in_outage"]
    first_start: dict[str, datetime] = {}
    for session in affected["sessions"]:
        start = datetime.fromisoformat(session["start"])
        if session["patient_id"] not in first_start or start < first_start[session["patient_id"]]:
            first_start[session["patient_id"]] = start

    scored = []
    for patient in patients:
        start = first_start.get(patient["id"])
        if start is None:
            continue
        facts = _facts(patient, bool(home[patient["id"]]), start - now <= timedelta(hours=WITHIN_HOURS))
        urgency_reasons = [key for key in rules["urgency"] if facts.get(key)]
        difficulty_reasons = [key for key in rules["difficulty"] if facts.get(key)]
        urgency = sum(rules["urgency"][key] for key in urgency_reasons)
        difficulty = sum(rules["difficulty"][key] for key in difficulty_reasons)
        row = {"patient_id": patient["id"], "urgency": urgency, "difficulty": difficulty,
               "reasons": urgency_reasons + difficulty_reasons}
        sort_key = (-urgency, -difficulty, start, -_longest_open_drive(drive, patient["id"], closed), patient["id"])
        scored.append((sort_key, row))

    scored.sort(key=lambda item: item[0])
    return [{"patient_id": row["patient_id"], "rank": i, **{k: row[k] for k in ("urgency", "difficulty", "reasons")}}
            for i, (_, row) in enumerate(scored, 1)]
