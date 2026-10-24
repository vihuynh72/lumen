"""Validate the seed files in data/seed/.

Run from the repo root: python scripts/validate_seed.py
Exit 0 when every check passes, 1 with one error per line otherwise.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
SCHEMAS = ROOT / "contracts" / "schemas"
sys.path.insert(0, str(ROOT / "backend"))
from lumen.affected import point_in_polygon  # noqa: E402

MWF = ["Mon", "Wed", "Fri"]
TTS = ["Tue", "Thu", "Sat"]
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$")
CALLBACK = re.compile(r"^555-01\d{2}$")

# Fallback when contracts/schemas/ is not on this branch yet (master plan section 6).
CLINIC_FIELDS = {
    "id", "name", "address", "phone", "lat", "lng", "stations", "late_shift", "chain", "home",
    "kind", "backup_power", "isolation_station", "accepts_visiting", "slots", "simulated",
}
PATIENT_FIELDS = {
    "id", "name", "days", "shift", "hours", "last_session", "home", "ride", "lives_alone",
    "language", "mobility", "hep_b_positive", "flags", "callback", "second_contact",
}
RULES = {
    "label": None,
    "urgency": {"session_in_window", "session_within_36h", "heart_failure", "missed_recently"},
    "difficulty": {"paratransit", "home_in_outage", "no_car", "lives_alone", "wheelchair", "limited_english"},
    "modes": {"early_min_hours", "transfer_min_hours"},
    "drive_cap_minutes": None,
    "pickup_buffer_minutes": None,
    "gap_limit_days": None,
}

errors = []


def load_json(name):
    path = SEED / name
    if not path.exists():
        errors.append(f"{name}: missing")
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        errors.append(f"{name}: invalid JSON ({exc})")
        return None


def check_schema(name, items, schema_file):
    schema_path = SCHEMAS / schema_file
    if not schema_path.exists():
        return False
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        errors.append("jsonschema is not installed: pip install jsonschema")
        return True
    validator = Draft202012Validator(json.loads(schema_path.read_text()))
    for item in items:
        label = item.get("id", "") if isinstance(item, dict) else ""
        for err in validator.iter_errors(item):
            path = "/".join(str(p) for p in err.absolute_path)
            errors.append(f"{name} {label} {path}: {err.message}".replace("  ", " "))
    return True


def check_fields(name, items, fields):
    for item in items:
        missing = fields - set(item)
        extra = set(item) - fields
        if missing:
            errors.append(f"{name} {item.get('id')}: missing {sorted(missing)}")
        if extra:
            errors.append(f"{name} {item.get('id')}: unknown {sorted(extra)}")


def notice_area(text):
    match = re.search(r"^Area:\s*(.+)$", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def main():
    clinics = load_json("clinics.json") or []
    patients = load_json("patients.json") or []
    polygon = load_json("outage_area.geojson")
    rules = load_json("rules.json")

    if not check_schema("clinics.json", clinics, "clinic.schema.json"):
        check_fields("clinics.json", clinics, CLINIC_FIELDS)
    if not check_schema("patients.json", patients, "patient.schema.json"):
        check_fields("patients.json", patients, PATIENT_FIELDS)
    if rules is not None and not check_schema("rules.json", [rules], "rules.schema.json"):
        for key, sub in RULES.items():
            if key not in rules:
                errors.append(f"rules.json: missing {key}")
            elif sub is not None and set(rules[key]) != sub:
                errors.append(f"rules.json {key}: keys must be {sorted(sub)}")

    # IDs
    for name, items in (("clinics.json", clinics), ("patients.json", patients)):
        ids = [i.get("id") for i in items]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            errors.append(f"{name}: duplicate ids {sorted(dupes)}")

    # Clinics
    homes = [c for c in clinics if c.get("home")]
    if len(homes) != 1:
        errors.append(f"clinics.json: exactly one clinic needs home true, found {len(homes)}")
    if not any(c.get("kind") == "hospital" for c in clinics):
        errors.append("clinics.json: no clinic with kind hospital")
    for c in clinics:
        for s in c.get("slots", []):
            if s.get("shift") == 4 and not c.get("late_shift"):
                errors.append(f"clinics.json {c.get('id')}: shift 4 (late) slot but late_shift is false")

    # Patients
    for p in patients:
        pid = p.get("id")
        if p.get("days") not in (MWF, TTS):
            errors.append(f"patients.json {pid}: days must be {MWF} or {TTS}")
        if not CALLBACK.match(str(p.get("callback", ""))):
            errors.append(f"patients.json {pid}: callback must be in the fictional 555-01XX range")
        if not TIMESTAMP.match(str(p.get("last_session", ""))):
            errors.append(f"patients.json {pid}: last_session needs an explicit UTC offset")

    # Polygon, home clinic and notice
    ring = None
    area = None
    try:
        feature = polygon["features"][0]
        ring = feature["geometry"]["coordinates"][0]
        area = feature["properties"]["event_area"]
        if feature["geometry"]["type"] != "Polygon" or ring[0] != ring[-1]:
            errors.append("outage_area.geojson: needs one closed Polygon")
    except (TypeError, KeyError, IndexError):
        errors.append("outage_area.geojson: needs a FeatureCollection with one Polygon Feature and properties.event_area")
    if ring and len(homes) == 1 and not point_in_polygon(homes[0]["lng"], homes[0]["lat"], ring):
        errors.append(f"outage_area.geojson: home clinic {homes[0]['id']} is outside the polygon")

    for notice_file in ("notice.txt", "notice_short.txt"):
        path = SEED / notice_file
        if not path.exists():
            if notice_file == "notice.txt":
                errors.append("notice.txt: missing")
            continue
        text = path.read_text()
        if "Event ID:" not in text:
            errors.append(f"{notice_file}: no 'Event ID:' line")
        if area is not None and notice_area(text) != area:
            errors.append(f"{notice_file}: 'Area:' line must equal event_area {area!r}")

    if errors:
        print("\n".join(errors))
        return 1
    inside = sum(1 for p in patients if ring and point_in_polygon(p["home"]["lng"], p["home"]["lat"], ring))
    print(f"seed OK: {len(clinics)} clinics, {len(patients)} patients ({inside} homes in the outage area), rules, notice")
    return 0


if __name__ == "__main__":
    sys.exit(main())
