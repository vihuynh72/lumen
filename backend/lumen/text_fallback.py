"""Template text when write_plan_text (Bedrock) fails: English messages and a counted summary (master plan section 10)."""

from datetime import datetime

from lumen.affected import session_start

CALLBACK = "555-0100"  # fictional clinic line (decision log D7)
MOVES = ("early_session", "transfer")


def _clock(d):
    return d.strftime("%-I:%M %p")


def message(row, clinics, own_id=None):
    """The master plan template, with the {name} placeholder kept for the router to fill. own_id: the patient's own
    clinic (patient clinic_id), the sender; None means the home clinic."""
    home = next(c for c in clinics if c["id"] == own_id) if own_id else next(c for c in clinics if c["home"])
    clinic = next(c for c in clinics if c["id"] == row["clinic_id"])
    old = datetime.fromisoformat(row["affected_session"])
    new = session_start(datetime.fromisoformat(row["slot"]["date"]).date(), row["slot"]["shift"])
    pickup = _clock(datetime.fromisoformat(row["pickup_time"]))
    place = "your usual clinic" if clinic["id"] == home["id"] else f"{clinic['name']}, {clinic['address'].split(',')[0]}"  # street only: under 40 words
    ride = {"paratransit": f"Paratransit picks you up at {pickup}.", "self": f"Please leave home by {pickup}.",
            "family": f"Please leave home by {pickup}."}.get(row["ride"], f"A ride picks you up at {pickup}.")
    when = _clock(new) if new.date() == old.date() else f"{new:%A}, {new:%b} {new.day}, {_clock(new)},"
    return (f"{{name}}, this is {home['name'].removesuffix(' Dialysis')}. A power shutoff moves your {old:%A} treatment to "
            f"{when} at {place}. {ride} Questions? Call {CALLBACK}.")


def fill(plan, clinics, only_ids=None, usual=None):
    """Return a copy of the plan with template messages on moves (only_ids limits the rows) and a summary.
    usual: {patient_id: clinic_id}, each patient's own clinic; a patient not in it belongs to the home clinic."""
    rows = []
    for r in plan["patients"]:
        if (only_ids is None or r["patient_id"] in only_ids) and r["action"] in MOVES and r["slot"]:
            r = {**r, "messages": {"en": message(r, clinics, (usual or {}).get(r["patient_id"]))}}
        rows.append(r)
    return {**plan, "patients": rows, "summary": plan["summary"] if only_ids is not None else summary(rows)}


def summary(rows):
    """The plan in one or two sentences from code counts. A part whose count is 0 is left out."""
    parts = []
    for action, one, many in (("early_session", "dialyzes early", "dialyze early"),
                              ("transfer", "moves to another clinic", "move to another clinic"),
                              ("hospital", "needs a phone call", "need a phone call")):
        n = sum(r["action"] == action for r in rows)
        if n:
            noun = "" if parts else ("patient " if n == 1 else "patients ")  # only the first part names the noun
            parts.append(f"{n} {noun}{one if n == 1 else many}")
    if not parts:
        text = "No patient needs a change"
    elif len(parts) == 1:
        text = parts[0]
    else:
        text = f"{', '.join(parts[:-1])}{',' if len(parts) > 2 else ''} and {parts[-1]}"
    rides = sum(r["book_today"] for r in rows)
    return f"{text}." + (f" Book {rides} paratransit ride{'' if rides == 1 else 's'} today." if rides else "")
