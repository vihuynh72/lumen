"""Apply Rosa's approvals, row edits and packet sends to a plan and return the next version (POST /approve, POST /packet)."""

import copy
import time

from lumen.check import blocks_row

ACTOR = "Rosa"
EDIT_STATUSES = ("approved", "confirmed", "declined", "no_answer")


class UnknownPatient(ValueError, LookupError):
    """An ID that is not in the plan: the router answers 404."""


def apply(plan, patient_ids, edits, now):
    """A new plan version; the input plan is not changed. Raises ValueError on a bad request."""
    start = time.perf_counter()
    new = copy.deepcopy(plan)
    ts = now.isoformat(timespec="seconds")
    rows = {r["patient_id"]: r for r in new["patients"]}

    def row(pid):
        if not isinstance(pid, str):
            raise ValueError(f"patient IDs must be strings, not {pid!r}")
        if pid not in rows:
            raise UnknownPatient(f"unknown patient {pid}")
        return rows[pid]

    def audit(change):
        new["audit"].append({"ts": ts, "actor": ACTOR, "change": change})

    if not isinstance(patient_ids, list):
        raise ValueError("patient_ids must be a list")
    if not isinstance(edits, list):
        raise ValueError("edits must be a list")

    if "all" in patient_ids:
        if patient_ids != ["all"]:
            raise ValueError('"all" cannot be mixed with patient IDs')
        drafts = [r for r in new["patients"] if r["status"] == "draft"]
        for r in drafts:
            r["status"] = "approved"
        if drafts:  # a repeat "approve all" changes nothing, so it logs nothing
            audit("approved all")
    else:
        for pid in patient_ids:
            r = row(pid)
            if r["status"] == "draft":
                r["status"] = "approved"
                audit(f"approved {pid}")

    for edit in edits:
        if not isinstance(edit, dict) or "patient_id" not in edit:
            raise ValueError("each edit needs a patient_id")
        r = row(edit["patient_id"])
        pid = r["patient_id"]
        if "pinned" in edit and not isinstance(edit["pinned"], bool):
            raise ValueError(f"{pid}: pinned must be true or false")
        if "status" in edit and edit["status"] not in EDIT_STATUSES:
            raise ValueError(f"{pid}: status must be one of {', '.join(EDIT_STATUSES)}")
        if edit.get("pinned", r["pinned"]) != r["pinned"]:
            r["pinned"] = edit["pinned"]
            audit(f"{'pinned' if r['pinned'] else 'unpinned'} {pid}")
        if edit.get("status", r["status"]) != r["status"]:
            r["status"] = edit["status"]
            audit(f"{pid} status {r['status']}")

    new.update(version=plan["version"] + 1, created_at=ts)
    new["timing_ms"] = {"total": round((time.perf_counter() - start) * 1000)}
    new["ai_sources"] = {}  # no AI step runs here; do not keep the old version's sources
    return new


def send_packets(plan, patient_ids, blocks, clinics, now):
    """Simulated transfer-packet send (POST /packet): nothing leaves Lumen. Returns (the next version, or None when
    nothing was sent; the sent IDs; skipped [{patient_id, reason}]). blocks: check.check_plan's block issues for this plan."""
    if not isinstance(patient_ids, list) or not patient_ids or not all(isinstance(p, str) for p in patient_ids):
        raise ValueError("patient_ids must be a non-empty list of patient IDs")
    start = time.perf_counter()
    new = copy.deepcopy(plan)
    ts = now.isoformat(timespec="seconds")
    rows = {r["patient_id"]: r for r in new["patients"]}
    sent, skipped = [], []
    for pid in dict.fromkeys(patient_ids):
        if pid not in rows:
            raise UnknownPatient(f"unknown patient {pid}")
        r = rows[pid]
        block = next((b for b in blocks if blocks_row(b, r)), None)
        if r["action"] not in ("transfer", "hospital"):
            reason = f"{r['action']} rows get no packet"
        elif r["status"] not in ("approved", "confirmed"):
            reason = f"status is {r['status']}, not approved or confirmed"
        elif block:
            reason = f"blocked: {block['text']}"
        elif r.get("packet", {}).get("status") == "sent":
            reason = "packet already sent"
        else:
            clinic = clinics[r["clinic_id"]]
            r["packet"] = {"status": "sent", "sent_at": ts, "channel": "simulated fax",
                           "to": f"{clinic['name']} {clinic['phone']}", "version": plan["version"]}
            new["audit"].append({"ts": ts, "actor": ACTOR, "change": f"{pid} packet sent (simulated fax to {clinic['phone']})"})
            sent.append(pid)
            continue
        skipped.append({"patient_id": pid, "reason": reason})
    if not sent:
        return None, sent, skipped
    new.update(version=plan["version"] + 1, created_at=ts)
    new["timing_ms"] = {"total": round((time.perf_counter() - start) * 1000)}
    new["ai_sources"] = {}
    return new, sent, skipped
