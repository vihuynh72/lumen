"""Re-plan tools (team rules, Rule 3). AI's replan() and the intent step decide what to change; this module decides what each change does."""

import copy
import re
import unicodedata
from datetime import datetime, timedelta

from lumen import store
from lumen.affected import find_affected, session_start
from lumen.geo import drive_minutes
from lumen.match import match

DIFF_FIELDS = ("action", "clinic_id", "slot", "drive_minutes", "drive_source", "pickup_time", "book_today", "flags", "status", "pinned")
DECISION = ("action", "clinic_id", "slot")
RANK_FIELDS = ("patient_id", "rank", "urgency", "difficulty", "reasons")
DECLINE = re.compile(r"^\s*(?P<name>.+?)\s+(?:declined|declines|can'?t come|cannot come|will not come|won'?t come)\W*$", re.IGNORECASE)
NUMBERS = {"no": 0, "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


def diff_rows(old_rows, new_rows):
    """Flat diff, one entry per changed field per patient (contracts/schemas/replan.schema.json)."""
    old = {r["patient_id"]: r for r in old_rows}
    return [{"patient_id": r["patient_id"], "field": f, "from": old[r["patient_id"]][f], "to": r[f]}
            for r in new_rows if r["patient_id"] in old for f in DIFF_FIELDS if old[r["patient_id"]][f] != r[f]]


def build_tools(event_id, plan, seeds):
    """The five functions replan() calls, plus the capacity cuts they applied. They share one working copy of the slots and rows."""
    event = store.load_event(event_id)
    if event is None:
        raise LookupError(f"no event {event_id}")
    clinics = copy.deepcopy(seeds["clinics"])
    patients, rules = seeds["patients"], seeds["rules"]
    now = datetime.fromisoformat(event["issued_at"]) + timedelta(minutes=30)  # the plan's demo clock, as in /plan
    affected = find_affected(event, clinics, patients, seeds["outage_area"], now, rules["modes"])
    drive = drive_minutes(patients, clinics)
    old_rows = {r["patient_id"]: r for r in plan["patients"]}
    work = {"rows": copy.deepcopy(plan["patients"]), "overflow": list(plan["overflow"])}
    changed_clinics, touched = set(), set()
    overrides = []  # the cuts this working copy applied; the router saves them as plan["capacity_overrides"]

    def row(patient_id):
        found = next((r for r in work["rows"] if r["patient_id"] == patient_id), None)
        if found is None:
            raise ValueError(f"no patient {patient_id} in the plan")
        return found

    def dialysis_clinic(clinic_id):
        found = next((c for c in clinics if c["id"] == clinic_id and c["kind"] == "dialysis"), None)
        if found is None:
            raise ValueError(f"no dialysis clinic {clinic_id}")
        return found

    def check_slot(date, shift):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(date)) or type(shift) is not int or shift not in (1, 2, 3, 4):
            raise ValueError(f"need a date YYYY-MM-DD and a shift 1 to 4, not {date!r} and {shift!r}")

    def locked_in(clinic_id, date, shift):
        return sum(1 for r in work["rows"] if (r["pinned"] or r["status"] == "confirmed") and r["status"] != "declined"
                   and r["clinic_id"] == clinic_id and r["slot"] == {"date": date, "shift": shift})

    def set_clinic_capacity(clinic_id, date, shift, chairs):
        clinic = dialysis_clinic(clinic_id)
        check_slot(date, shift)
        if type(chairs) is not int or chairs < 0:
            raise ValueError("chairs must be a whole number of 0 or more")
        if chairs < locked_in(clinic_id, date, shift):
            raise ValueError(f"{clinic_id} {date} shift {shift} holds {locked_in(clinic_id, date, shift)} pinned or confirmed patients")
        slot = next((s for s in clinic["slots"] if (s["date"], s["shift"]) == (date, shift)), None)
        if slot is None:
            clinic["slots"].append({"date": date, "shift": shift, "open_chairs": chairs})
        else:
            slot["open_chairs"] = chairs
        changed_clinics.add(clinic_id)
        overrides.append({"clinic_id": clinic_id, "date": date, "shift": shift, "open_chairs": chairs})
        return dict(overrides[-1])

    def pin_patient(patient_id, clinic_id, date, shift):
        r = row(patient_id)
        clinic = dialysis_clinic(clinic_id)
        check_slot(date, shift)
        if not any((s["date"], s["shift"]) == (date, shift) for s in clinic["slots"]):
            raise ValueError(f"{clinic_id} has no slot on {date} shift {shift}")
        if (r["clinic_id"], r["slot"]) != (clinic_id, {"date": date, "shift": shift}):
            changed_clinics.add(clinic_id)  # re-match the slot's other patients so the pin can take a chair
            minutes = drive[patient_id][clinic_id]["minutes"]
            start = session_start(datetime.fromisoformat(date).date(), shift)
            r.update(action="early_session" if clinic["home"] else "transfer", clinic_id=clinic_id,
                     slot={"date": date, "shift": shift}, drive_minutes=minutes, drive_source=drive[patient_id][clinic_id]["source"],
                     pickup_time=(start - timedelta(minutes=minutes + rules["pickup_buffer_minutes"])).isoformat(),
                     book_today=r["ride"] == "paratransit", flags=[f for f in r["flags"] if f == "long_gap_after"],
                     reason_text=None, messages={}, audio={})
            # shortcut: long_gap_after is kept from the old slot, not recomputed; match recomputes it for unpinned rows
        r["pinned"] = True
        touched.add(patient_id)
        return {k: r[k] for k in ("patient_id", "action", "clinic_id", "slot", "pinned")}

    def decline_patient(patient_id):
        row(patient_id)["status"] = "declined"
        touched.add(patient_id)
        return {"patient_id": patient_id, "status": "declined"}

    def rerun_matching():
        # Lock every chair the instruction did not touch, so only rows at a changed clinic (and touched rows) move.
        locked = [r for r in work["rows"] if r["pinned"] or r["status"] in ("confirmed", "declined")
                  or (r["slot"] and r["clinic_id"] not in changed_clinics and r["patient_id"] not in touched)]
        ranked = [{k: r[k] for k in RANK_FIELDS} for r in sorted(work["rows"], key=lambda r: r["rank"])]
        result = match(ranked, affected, patients, clinics, rules, drive, locked)
        for r in result["patients"]:
            old = old_rows.get(r["patient_id"])
            if old and all(r[k] == old[k] for k in DECISION):  # same chair: keep its text and status
                r.update({k: old[k] for k in ("reason_text", "messages", "audio", "status")})
        work["rows"], work["overflow"] = result["patients"], result["overflow"]
        return {"patients": work["rows"], "overflow": work["overflow"]}

    def diff_plans():
        return diff_rows(plan["patients"], work["rows"])

    return {"set_clinic_capacity": set_clinic_capacity, "pin_patient": pin_patient, "decline_patient": decline_patient,
            "rerun_matching": rerun_matching, "diff_plans": diff_plans, "capacity_overrides": overrides}


def apply_changes(changes, plan, tools, clinics, names):
    """Apply checked re-plan changes with the tools, re-match once, and write the summary and the understood sentences in
    code. changes: {"kind": "clinic_limit", clinic_id, more} | {"kind": "decline", patient_id} | {"kind": "pin", patient_id,
    clinic_id, date, shift}. names: patient names, for the understood sentences only (the response, never the stored plan)."""
    by_id = {c["id"]: c for c in clinics}
    limits, understood = [], []
    for ch in changes:
        if ch["kind"] == "clinic_limit":
            clinic, n = by_id[ch["clinic_id"]], ch["more"]
            # N more = at most N visiting patients at that clinic across all slots: pinned and confirmed rows first, then rank order
            keep = sorted((r for r in plan["patients"] if r["clinic_id"] == clinic["id"] and r["slot"] and r["status"] != "declined"),
                          key=lambda r: (not (r["pinned"] or r["status"] == "confirmed"), r["rank"]))[:n]
            for s in clinic["slots"]:
                tools["set_clinic_capacity"](clinic["id"], s["date"], s["shift"],
                                             sum(1 for r in keep if (r["slot"]["date"], r["slot"]["shift"]) == (s["date"], s["shift"])))
            limits.append(f"{clinic['name']} can take only {n} more")
            understood.append(f"{clinic['name']} takes at most {n} more patient{'' if n == 1 else 's'}.")
        elif ch["kind"] == "decline":
            tools["decline_patient"](ch["patient_id"])
            understood.append(f"{names[ch['patient_id']]} will not come. Staff call them.")
        else:
            tools["pin_patient"](ch["patient_id"], ch["clinic_id"], ch["date"], ch["shift"])
            at = session_start(datetime.fromisoformat(ch["date"]).date(), ch["shift"])
            understood.append(f"{names[ch['patient_id']]} goes to {by_id[ch['clinic_id']]['name']}, "
                              f"{at:%a %b} {at.day}, {at.hour % 12 or 12}:{at:%M %p}.")
    result = tools["rerun_matching"]()
    diff = tools["diff_plans"]()
    moved = {d["patient_id"] for d in diff if d["field"] == "clinic_id"}
    to_staff = set(result["overflow"]) - set(plan["overflow"])

    def count(k, noun, one, many):
        return f"{k} {noun}{'' if k == 1 else 's'} {one if k == 1 else many}"

    lead = f"{' and '.join(limits)}, so " if limits else ""
    summary = (f"{lead}{count(len(moved), 'patient', 'moves', 'move')} to other chairs or the staff call list. "
               f"{count(len(to_staff), 'more patient', 'needs', 'need')} a staff call.")
    return {"plan": {**plan, **result}, "diff": diff, "summary": summary, "understood": understood}


def _plain(text):
    return "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c)).casefold()


def replan_by_rules(instruction, plan, tools, clinics, patients=()):
    """Rule-based re-plan for "(clinic name) can only take N more" and "(full name) declined". Used when the model steps
    are off or fail."""
    d = DECLINE.match(instruction)
    if d:
        rows = {r["patient_id"] for r in plan["patients"]}
        hits = [p for p in patients if p["id"] in rows and _plain(p["name"]) == _plain(d["name"].strip())]
        if len(hits) != 1:
            raise ValueError(f"no single patient in the plan is named '{d['name'].strip()}'")
        return apply_changes([{"kind": "decline", "patient_id": hits[0]["id"]}], plan, tools, clinics, {hits[0]["id"]: hits[0]["name"]})
    m = re.match(r"^\s*(?P<name>.+?)\s+can only take (?P<n>\d+|\w+) more(\s+patients?)?\W*$", instruction, re.IGNORECASE)
    n = m and (int(m.group("n")) if m.group("n").isdigit() else NUMBERS.get(m.group("n").lower()))
    if n is None:
        raise ValueError("the rule-based re-plan understands only '(clinic name) can only take N more'")
    name = m.group("name").strip().lower()
    hits = [c for c in clinics if c["kind"] == "dialysis" and name in c["name"].lower()]
    exact = [c for c in hits if c["name"].lower() == name]
    if len(exact or hits) != 1:
        found = ", ".join(c["name"] for c in hits) or "no clinic"
        raise ValueError(f"'{m.group('name').strip()}' matches {found}; use the full clinic name")
    return apply_changes([{"kind": "clinic_limit", "clinic_id": (exact or hits)[0]["id"], "more": n}], plan, tools, clinics, {})
