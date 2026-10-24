"""Give each affected session one action: early_session, transfer or hospital (master plan section 8, step 5)."""

from datetime import datetime, time, timedelta

from lumen.affected import WEEKDAY, session_start

ORDER = {
    "early": ["early_session", "transfer", "hospital"],
    "transfer": ["transfer", "early_session", "hospital"],
    "critical": ["transfer", "hospital"],
}
PARATRANSIT_START = time(6, 30)  # El Dorado Transit ADA paratransit starts at 6:30 AM (decision log D9)
CHAIR_FIELDS = ("clinic_id", "slot", "drive_minutes", "drive_source", "pickup_time")


def blank_row(r, patient, affected_session):
    return {
        "patient_id": r["patient_id"], "rank": r["rank"], "urgency": r["urgency"], "difficulty": r["difficulty"],
        "reasons": list(r["reasons"]), "reason_text": None, "affected_session": affected_session,
        "action": "notify_only", "clinic_id": None, "slot": None, "drive_minutes": None, "drive_source": None,
        "pickup_time": None, "ride": patient["ride"], "book_today": False, "flags": [], "messages": {},
        "audio": {}, "status": "draft", "pinned": False,
    }


def regular_dates(patient, around, step):
    """Yield the patient's regular session dates after (step=1) or before (step=-1) the date `around`."""
    days = {WEEKDAY[d] for d in patient["days"]}
    for i in range(1, 8):
        d = around + timedelta(days=i * step)
        if d.weekday() in days:
            yield d


def match(ranked, affected, patients, clinics, rules, drive, locked=None):
    now = datetime.fromisoformat(affected["now"])
    window_start = datetime.fromisoformat(affected["window"]["start"])
    tz = now.tzinfo
    by_id = {p["id"]: p for p in patients}
    sessions = {s["patient_id"]: s for s in affected["sessions"]}
    home = next(c for c in clinics if c["home"])
    hospital = next(c for c in clinics if c["kind"] == "hospital")  # shortcut: first hospital; pick the nearest if the seed gets two
    open_now = {(c["id"], s["date"], s["shift"]): s["open_chairs"] for c in clinics for s in c["slots"]}  # a copy; inputs stay unchanged
    mode = affected["mode"]

    rows, overflow = [], []
    locked = {r["patient_id"]: r for r in (locked or [])}
    for row in locked.values():
        if row["status"] != "declined" and row["slot"]:
            open_now[(row["clinic_id"], row["slot"]["date"], row["slot"]["shift"])] -= 1

    def take(row, p, clinic, slot, s_date, action):
        d = drive[p["id"]][clinic["id"]]
        start = session_start(datetime.fromisoformat(slot["date"]).date(), slot["shift"], tz)
        pickup = start - timedelta(minutes=d["minutes"] + rules["pickup_buffer_minutes"])
        if p["ride"] == "paratransit" and pickup.time() < PARATRANSIT_START:
            return False
        open_now[(clinic["id"], slot["date"], slot["shift"])] -= 1
        row.update(action=action, clinic_id=clinic["id"], slot={"date": slot["date"], "shift": slot["shift"]},
                   drive_minutes=d["minutes"], drive_source=d["source"], pickup_time=pickup.isoformat(),
                   book_today=p["ride"] == "paratransit")
        if (next(regular_dates(p, s_date, 1)) - start.date()).days > rules["gap_limit_days"]:
            row["flags"].append("long_gap_after")
        return True

    def try_early(row, p, s_date):
        prev = next(regular_dates(p, s_date, -1))
        for slot in sorted(home["slots"], key=lambda s: (s["date"], s["shift"])):
            start = session_start(datetime.fromisoformat(slot["date"]).date(), slot["shift"], tz)
            if (open_now[(home["id"], slot["date"], slot["shift"])] > 0 and start > now
                    and start + timedelta(hours=p["hours"]) <= window_start and start.date() > prev
                    and take(row, p, home, slot, s_date, "early_session")):
                return True
        return False

    def try_transfer(row, p, s_date):
        options = []
        for c in clinics:
            if c["kind"] != "dialysis" or c["id"] in affected["closed_clinic_ids"] or not c["accepts_visiting"]:
                continue
            if p["hep_b_positive"] and not c["isolation_station"]:
                continue
            minutes = drive[p["id"]][c["id"]]["minutes"]
            if minutes > rules["drive_cap_minutes"]:
                continue
            for slot in c["slots"]:
                d = datetime.fromisoformat(slot["date"]).date()
                if (open_now[(c["id"], slot["date"], slot["shift"])] > 0 and d in (s_date, s_date - timedelta(days=1))
                        and session_start(d, slot["shift"], tz) > now):
                    options.append(((minutes, slot["shift"] != p["shift"], d != s_date, slot["date"], slot["shift"]), c, slot))
        return any(take(row, p, c, slot, s_date, "transfer") for _, c, slot in sorted(options, key=lambda o: o[0]))

    for r in ranked:
        pid = r["patient_id"]
        p = by_id[pid]
        if pid in locked and locked[pid]["status"] != "declined":
            rows.append(locked[pid])
            continue
        s = sessions.get(pid)
        row = blank_row(r, p, s["start"] if s else None)
        if pid in locked:  # declined: no chair, a staff call, overflow; the action stays
            row.update(locked[pid], **{f: None for f in CHAIR_FIELDS}, book_today=False)
            row["flags"] = sorted(set(row["flags"]) - {"long_gap_after"} | {"staff_call"})
            overflow.append(pid)
        elif s:
            s_date = datetime.fromisoformat(s["start"]).date()
            for option in ORDER[mode]:
                if option == "early_session" and try_early(row, p, s_date):
                    break
                if option == "transfer" and try_transfer(row, p, s_date):
                    break
                if option == "hospital":
                    row.update(action="hospital", clinic_id=hospital["id"], flags=["staff_call"])
                    overflow.append(pid)
                    break
        if mode == "critical" and "staff_call" not in row["flags"]:
            row["flags"].append("staff_call")
        rows.append(row)

    # Unaffected patients that rank_patients did not rank get a notify_only row at the end.
    ranked_ids = {r["patient_id"] for r in ranked}
    for p in patients:
        if p["id"] not in ranked_ids and p["id"] not in sessions:
            rows.append(blank_row({"patient_id": p["id"], "rank": len(rows) + 1, "urgency": 0, "difficulty": 0, "reasons": []}, p, None))
    return {"patients": rows, "overflow": overflow}
