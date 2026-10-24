"""Apply Rosa's approvals and row edits to a plan and return the next version (POST /approve)."""

import copy
import time

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
    return new
