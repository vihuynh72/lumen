"""Template text when write_plan_text (Bedrock) fails: English messages and a counted summary (master plan section 10)."""

from datetime import datetime

from lumen.affected import session_start

CALLBACK = "555-0100"  # fictional clinic line (decision log D7)
MOVES = ("early_session", "transfer")


def _clock(d):
    return d.strftime("%-I:%M %p")


def message(row, clinics):
    """The master plan template, with the {name} placeholder kept for the router to fill."""
    home = next(c for c in clinics if c["home"])
    clinic = next(c for c in clinics if c["id"] == row["clinic_id"])
    old = datetime.fromisoformat(row["affected_session"])
    new = session_start(datetime.fromisoformat(row["slot"]["date"]).date(), row["slot"]["shift"])
    pickup = _clock(datetime.fromisoformat(row["pickup_time"]))
    place = "your usual clinic" if clinic["home"] else f"{clinic['name']}, {clinic['address'].split(',')[0]}"  # street only: under 40 words
    ride = {"paratransit": f"Paratransit picks you up at {pickup}.", "self": f"Please leave home by {pickup}.",
            "family": f"Please leave home by {pickup}."}.get(row["ride"], f"A ride picks you up at {pickup}.")
    when = _clock(new) if new.date() == old.date() else f"{new:%A}, {new:%b} {new.day}, {_clock(new)},"
    return (f"{{name}}, this is {home['name'].removesuffix(' Dialysis')}. A power shutoff moves your {old:%A} treatment to "
            f"{when} at {place}. {ride} Questions? Call {CALLBACK}.")


def fill(plan, clinics, only_ids=None):
    """Return a copy of the plan with template messages on moves (only_ids limits the rows) and a summary."""
    rows = []
    for r in plan["patients"]:
        if (only_ids is None or r["patient_id"] in only_ids) and r["action"] in MOVES and r["slot"]:
            r = {**r, "messages": {"en": message(r, clinics)}}
        rows.append(r)
    count = {a: sum(1 for r in rows if r["action"] == a) for a in ("early_session", "transfer", "hospital")}
    rides = sum(1 for r in rows if r["book_today"])
    summary = (f"{count['early_session']} patients dialyze early, {count['transfer']} move to another clinic, "
               f"and {count['hospital']} need a staff call. Book {rides} paratransit rides today.")
    return {**plan, "patients": rows, "summary": plan["summary"] if only_ids is not None else summary}
