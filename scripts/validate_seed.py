"""Validate the seed files of both regions: data/seed/ (El Dorado) and data/seed/santaclara/ (Santa Clara).

Run from the repo root: python scripts/validate_seed.py
Exit 0 when every check passes, 1 with one error per line otherwise.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
REGIONS = {"eldorado": "", "santaclara": "santaclara/"}  # region -> folder under data/seed/, the same as the S3 seed/ prefix
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
    path = SEED / name  # name includes the region folder, so every error names its file
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


def check_region(folder):
    """Check one region's seed. Returns (clinics, patients, homes in the outage area) for the summary and cross-region checks."""
    clinics = load_json(f"{folder}clinics.json") or []
    patients = load_json(f"{folder}patients.json") or []
    polygon = load_json(f"{folder}outage_area.geojson")
    rules = load_json(f"{folder}rules.json")

    if not check_schema(f"{folder}clinics.json", clinics, "clinic.schema.json"):
        check_fields(f"{folder}clinics.json", clinics, CLINIC_FIELDS)
    if not check_schema(f"{folder}patients.json", patients, "patient.schema.json"):
        check_fields(f"{folder}patients.json", patients, PATIENT_FIELDS)
    if rules is not None and not check_schema(f"{folder}rules.json", [rules], "rules.schema.json"):
        for key, sub in RULES.items():
            if key not in rules:
                errors.append(f"{folder}rules.json: missing {key}")
            elif sub is not None and set(rules[key]) != sub:
                errors.append(f"{folder}rules.json {key}: keys must be {sorted(sub)}")

    # IDs
    for name, items in ((f"{folder}clinics.json", clinics), (f"{folder}patients.json", patients)):
        ids = [i.get("id") for i in items]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            errors.append(f"{name}: duplicate ids {sorted(dupes)}")

    # Clinics
    homes = [c for c in clinics if c.get("home")]
    if len(homes) != 1:
        errors.append(f"{folder}clinics.json: exactly one clinic needs home true, found {len(homes)}")
    if not any(c.get("kind") == "hospital" for c in clinics):
        errors.append(f"{folder}clinics.json: no clinic with kind hospital")
    for c in clinics:
        for s in c.get("slots", []):
            if s.get("shift") == 4 and not c.get("late_shift"):
                errors.append(f"{folder}clinics.json {c.get('id')}: shift 4 (late) slot but late_shift is false")

    # Patients
    for p in patients:
        pid = p.get("id")
        if p.get("days") not in (MWF, TTS):
            errors.append(f"{folder}patients.json {pid}: days must be {MWF} or {TTS}")
        if not CALLBACK.match(str(p.get("callback", ""))):
            errors.append(f"{folder}patients.json {pid}: callback must be in the fictional 555-01XX range")
        if not TIMESTAMP.match(str(p.get("last_session", ""))):
            errors.append(f"{folder}patients.json {pid}: last_session needs an explicit UTC offset")

    # Polygon, home clinic and notice
    ring = None
    area = None
    try:
        feature = polygon["features"][0]
        ring = feature["geometry"]["coordinates"][0]
        area = feature["properties"]["event_area"]
        if feature["geometry"]["type"] != "Polygon" or ring[0] != ring[-1]:
            errors.append(f"{folder}outage_area.geojson: needs one closed Polygon")
    except (TypeError, KeyError, IndexError):
        errors.append(f"{folder}outage_area.geojson: needs a FeatureCollection with one Polygon Feature and properties.event_area")
    if ring and len(homes) == 1 and not point_in_polygon(homes[0]["lng"], homes[0]["lat"], ring):
        errors.append(f"{folder}outage_area.geojson: home clinic {homes[0]['id']} is outside the polygon")

    for notice_file in ("notice.txt", "notice_short.txt"):
        path = SEED / folder / notice_file
        if not path.exists():
            if notice_file == "notice.txt":
                errors.append(f"{folder}notice.txt: missing")
            continue
        text = path.read_text()
        if "Event ID:" not in text:
            errors.append(f"{folder}{notice_file}: no 'Event ID:' line")
        if area is not None and notice_area(text) != area:
            errors.append(f"{folder}{notice_file}: 'Area:' line must equal event_area {area!r}")

    inside = sum(1 for p in patients if ring and isinstance(p.get("home"), dict) and point_in_polygon(p["home"]["lng"], p["home"]["lat"], ring))
    return clinics, patients, inside


def main():
    found = {region: check_region(folder) for region, folder in REGIONS.items()}
    # The regions share one API and one audio cache: patient IDs and callback numbers must never collide.
    for field in ("id", "callback"):
        values = [p.get(field) for _, patients, _ in found.values() for p in patients]
        shared = {v for v in values if values.count(v) > 1}
        if shared:
            errors.append(f"patients: {field} used more than once across the regions {sorted(shared)}")
    if errors:
        print("\n".join(errors))
        return 1
    for region, (clinics, patients, inside) in found.items():
        print(f"{region} seed OK: {len(clinics)} clinics, {len(patients)} patients ({inside} homes in the outage area), rules, notice")
    return 0


if __name__ == "__main__":
    sys.exit(main())
