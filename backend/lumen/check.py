"""Plan check (POST /check, POST /packet). Code decides every block and warning from the seed; the model only rewords them."""

import copy
from datetime import datetime, timedelta

from lumen.affected import LOCAL, outage_ring, point_in_polygon, session_start
from lumen.geo import drive_minutes
from lumen.match import PARATRANSIT_START, regular_dates

SENT_AWAY = ("transfer", "hospital")  # rows that go to another facility and get a packet
LANGUAGES = {"en": "English", "es": "Spanish", "zh": "Chinese"}
TEXT = {
    "hbv_no_isolation": "{pid} is HBsAg positive, but {facility} has no isolation station.",
    "over_capacity": "{facility} has {chairs} open chairs on {date} shift {shift}, but the plan sends {count} patients.",
    "clinic_closed": "{facility} is closed during the shutoff.",
    "no_visitors": "{facility} does not take visiting patients.",
    "no_late_shift": "{pid} has a late shift, but {facility} has no late shift.",
    "hbv_test_missing": "No HBV test date on file for {pid}: receiver tests on intake, result within 7 days.",
    "early_paratransit_pickup": "{pid} rides paratransit, but the pickup at {pickup} is before paratransit starts at 06:30.",
    "same_day_paratransit": "{pid} rides paratransit, which must be booked the day before, but the new session is today.",
    "long_drive": "{pid} has a {minutes}-minute drive to {facility}, longer than the {cap}-minute limit.",
    "long_gap_after": "{pid} waits more than {days} days from the new session to the next usual session.",
    "no_message_in_language": "{pid} has no message in {language}, the patient's language.",
    # Soft warnings: only the model proposes them, and soft_warnings() keeps one only when its facts are true.
    "heart_failure_long_gap": "{pid} has heart failure and a long gap before the next usual session.",
    "lives_alone_night_pickup": "{pid} lives alone and has a pickup in the dark at {pickup}.",
    "wheelchair_long_drive": "{pid} uses a wheelchair and has a {minutes}-minute drive to {facility}.",
    "language_unconfirmed": "Confirm that {facility} can speak {language} with {pid}.",
}
SOFT = {
    "heart_failure_long_gap": lambda f: f["heart_failure"] and f["long_gap_after"],
    "lives_alone_night_pickup": lambda f: f["lives_alone"] and f["pickup"] is not None and not "06:00" <= f["pickup"] < "19:00",
    # shortcut: "long" = over 30 minutes (half the drive cap); make it a rules.json key if staff want to tune it
    "wheelchair_long_drive": lambda f: f["mobility"] == "wheelchair" and (f["drive_minutes"] or 0) > 30,
    "language_unconfirmed": lambda f: f["language"] != "en" and f["action"] in SENT_AWAY,
}


def apply_overrides(clinics, overrides):
    """A copy of the clinics with the saved capacity cuts applied, the way set_clinic_capacity applies them."""
    clinics = copy.deepcopy(clinics)
    by_id = {c["id"]: c for c in clinics}
    for o in overrides or []:
        slots = by_id[o["clinic_id"]]["slots"]
        slot = next((s for s in slots if (s["date"], s["shift"]) == (o["date"], o["shift"])), None)
        if slot is None:
            slots.append({"date": o["date"], "shift": o["shift"], "open_chairs": o["open_chairs"]})
        else:
            slot["open_chairs"] = o["open_chairs"]
    return clinics


def row_facts(plan, seed):
    """Facts per moved row, recomputed from the seed: the row gives only action, facility, slot, status and messages.
    No names: these facts go to the model."""
    patients = {p["id"]: p for p in seed["patients"]}
    clinics = {c["id"]: c for c in seed["clinics"]}
    drive = drive_minutes(seed["patients"], seed["clinics"])
    gap_limit = seed["rules"]["gap_limit_days"]
    facts = []
    for r in plan["patients"]:
        if r["action"] == "notify_only" or r["status"] == "declined" or r["clinic_id"] is None:
            continue
        p, c = patients[r["patient_id"]], clinics[r["clinic_id"]]
        minutes = pickup = None
        long_gap = False
        if r["slot"]:
            minutes = drive[p["id"]][c["id"]]["minutes"]
            start = session_start(datetime.fromisoformat(r["slot"]["date"]).date(), r["slot"]["shift"])
            pickup = start - timedelta(minutes=minutes + seed["rules"]["pickup_buffer_minutes"])
            if r["affected_session"]:
                after = next(regular_dates(p, datetime.fromisoformat(r["affected_session"]).date(), 1))
                long_gap = (after - start.date()).days > gap_limit
        facts.append({
            "patient_id": p["id"], "action": r["action"], "facility_id": c["id"], "facility": c["name"], "slot": r["slot"],
            "pickup": pickup.astimezone(LOCAL).strftime("%H:%M") if pickup else None, "drive_minutes": minutes,
            "ride": p["ride"], "mobility": p["mobility"], "lives_alone": p["lives_alone"],
            "heart_failure": "heart_failure" in p["flags"], "hep_b_positive": p["hep_b_positive"], "language": p["language"],
            "usual_shift": p["shift"], "long_gap_after": long_gap, "message_languages": sorted(r["messages"]),
        })
    return facts


def _issue(severity, code, f=None, clinic=None, **values):
    facility = clinic or {"id": f["facility_id"], "name": f["facility"]}
    values = {"pid": f and f["patient_id"], "facility": facility["name"], "pickup": f and f["pickup"],
              "minutes": f and f["drive_minutes"], "language": f and LANGUAGES.get(f["language"], f["language"]), **values}
    return {"patient_id": f and f["patient_id"], "facility_id": facility["id"], "severity": severity, "code": code,
            "text": TEXT[code].format(**values)}


def check_plan(plan, seed, capacity_overrides=None):
    """Blocks first, then warnings. Each issue: patient_id (null for a facility issue), facility_id, severity, code, text."""
    clinics = {c["id"]: c for c in apply_overrides(seed["clinics"], capacity_overrides)}
    rules = seed["rules"]
    ring = outage_ring(seed["outage_area"])
    closed = {c["id"] for c in clinics.values() if point_in_polygon(c["lng"], c["lat"], ring) and c["backup_power"] != "full"}
    today = datetime.fromisoformat(plan["created_at"]).astimezone(LOCAL).date().isoformat()  # the demo clock of this version
    issues, booked = [], {}
    for f in row_facts(plan, seed):
        c = clinics[f["facility_id"]]
        if f["hep_b_positive"] and not c["isolation_station"]:
            issues.append(_issue("block", "hbv_no_isolation", f))
        if f["slot"]:
            key = (c["id"], f["slot"]["date"], f["slot"]["shift"])
            booked[key] = booked.get(key, 0) + 1
        if f["action"] == "transfer":  # clinics only: hospital rows are staff calls; early sessions end before the window
            if c["id"] in closed:
                issues.append(_issue("block", "clinic_closed", f))
            elif not c["accepts_visiting"]:
                issues.append(_issue("block", "no_visitors", f))
            if f["usual_shift"] == 4 and not c["late_shift"]:
                issues.append(_issue("warning", "no_late_shift", f))
            if f["drive_minutes"] > rules["drive_cap_minutes"]:
                issues.append(_issue("warning", "long_drive", f, cap=rules["drive_cap_minutes"]))
        if f["action"] in SENT_AWAY:
            issues.append(_issue("warning", "hbv_test_missing", f))  # the seed has no HBV test dates
        if f["ride"] == "paratransit" and f["slot"]:
            if f["slot"]["date"] <= today:
                issues.append(_issue("warning", "same_day_paratransit", f))
            elif f["pickup"] < PARATRANSIT_START.strftime("%H:%M"):
                issues.append(_issue("warning", "early_paratransit_pickup", f))
        if f["long_gap_after"]:
            issues.append(_issue("warning", "long_gap_after", f, days=rules["gap_limit_days"]))
        if f["action"] in ("early_session", "transfer") and f["language"] not in f["message_languages"]:
            issues.append(_issue("warning", "no_message_in_language", f))
    for (cid, date, shift), count in booked.items():
        chairs = next((s["open_chairs"] for s in clinics[cid]["slots"] if (s["date"], s["shift"]) == (date, shift)), 0)
        if count > chairs:
            issue = _issue("block", "over_capacity", clinic=clinics[cid], chairs=chairs, date=date, shift=shift, count=count)
            issues.append({**issue, "slot": {"date": date, "shift": shift}})
    return sorted(issues, key=lambda i: i["severity"] != "block")


def soft_warnings(proposed, facts):
    """The model's soft warnings that pass: a known code, a moved patient, and facts that are true. One per patient and code."""
    by_id = {f["patient_id"]: f for f in facts}
    kept = {}
    for s in proposed:
        f = by_id.get(s["patient_id"])
        if f and s["code"] in SOFT and SOFT[s["code"]](f):
            kept[(f["patient_id"], s["code"])] = _issue("warning", s["code"], f)
    return list(kept.values())


def blocks_row(issue, row):
    """True when a block issue stops this row: it names the patient, or it is the over-capacity block of the row's slot."""
    return issue["severity"] == "block" and (issue["patient_id"] == row["patient_id"] or (
        issue["patient_id"] is None and issue["facility_id"] == row["clinic_id"] and issue.get("slot") == row["slot"]))
