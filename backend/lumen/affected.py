"""Find closed clinics, homes in the outage area, affected sessions and the plan mode."""

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    LOCAL = ZoneInfo("America/Los_Angeles")  # shifts are clinic-local time
except ZoneInfoNotFoundError:
    LOCAL = timezone(timedelta(hours=-7))  # shortcut: PDT only; add tzdata if the runtime lacks zoneinfo

SHIFT_START = {1: time(6, 0), 2: time(10, 30), 3: time(15, 0), 4: time(19, 30)}
WEEKDAY = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}
DEFAULT_MODES = {"early_min_hours": 24, "transfer_min_hours": 6}  # same values as rules.json


def point_in_polygon(lng, lat, ring):
    """Ray casting. ring is a list of [lng, lat]. Points on a left or bottom edge count as inside."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def outage_ring(polygon):
    # shortcut: first Polygon feature only, outer ring only; upgrade if a notice ever covers several areas
    return polygon["features"][0]["geometry"]["coordinates"][0]


def session_start(date, shift):
    return datetime.combine(date, SHIFT_START[shift], tzinfo=LOCAL)


def mode_for(lead_hours, modes):
    if lead_hours >= modes["early_min_hours"]:
        return "early"
    if lead_hours >= modes["transfer_min_hours"]:
        return "transfer"
    return "critical"


def find_affected(event, clinics, patients, polygon, now, modes=None):
    ring = outage_ring(polygon)
    start = datetime.fromisoformat(event["start"])
    end = datetime.fromisoformat(event["end"])
    closed = [c["id"] for c in clinics if point_in_polygon(c["lng"], c["lat"], ring) and c["backup_power"] != "full"]
    home = next(c for c in clinics if c["home"])

    sessions = []
    for p in patients:
        clinic_id = p.get("clinic_id", home["id"])  # the patient's usual clinic; the home clinic when the seed has one clinic
        if clinic_id not in closed:
            continue
        days = {WEEKDAY[d] for d in p["days"]}
        for offset in range(5):  # the demo week, from the notice day on
            day = now.astimezone(LOCAL).date() + timedelta(days=offset)
            if day.weekday() not in days:
                continue
            s = session_start(day, p["shift"])
            e = s + timedelta(hours=p["hours"])
            if s < end and e > start:
                sessions.append({"patient_id": p["id"], "clinic_id": clinic_id, "start": s.isoformat(), "end": e.isoformat()})

    lead = round((start - now).total_seconds() / 3600, 1)
    return {
        "closed_clinic_ids": closed,
        "sessions": sessions,
        "home_in_outage": {p["id"]: point_in_polygon(p["home"]["lng"], p["home"]["lat"], ring) for p in patients},
        "mode": mode_for(lead, modes or DEFAULT_MODES),
        "lead_hours": lead,
        "now": now.isoformat(),
        "window": {"start": event["start"], "end": event["end"]},
    }
