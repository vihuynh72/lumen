"""Write data/seed/patients.json: 40 synthetic patients of the Cameron Park clinic.

Usage: python scripts/make_patients.py
The fixed random seed makes the file the same on every run. P001 to P005 are seed v0, unchanged,
so the contract fixtures still describe real roster patients.
"""

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
sys.path.insert(0, str(ROOT / "backend"))
from lumen.affected import outage_ring, point_in_polygon  # noqa: E402

rng = random.Random(20261026)

# Town centers (real towns near Cameron Park). Homes are random points within about 1.5 km.
TOWNS_IN = {"Cameron Park": (38.6688, -120.9872), "Shingle Springs": (38.6657, -120.9241), "Placerville": (38.7296, -120.7985),
            "Diamond Springs": (38.6946, -120.8149), "El Dorado": (38.6824, -120.8463)}
TOWNS_OUT = {"El Dorado Hills": (38.6857, -121.0822), "Pollock Pines": (38.7613, -120.5861), "Cool": (38.8871, -121.0145),
             "Lotus": (38.8030, -120.9080), "Coloma": (38.8000, -120.8894)}
# Most outside homes are west or north of the outage area; a few far-east homes (Pollock Pines) are over an hour from any open clinic.
OUT_WEIGHTS = ["El Dorado Hills"] * 4 + ["Cool"] * 2 + ["Lotus"] * 2 + ["Coloma"] * 2 + ["Pollock Pines"]
NAMES = {
    "en": ["Dorothy Keane", "Harold Briggs", "Patricia Lowell", "Gary Holcomb", "Sharon Pruitt", "Dennis Archer", "Carol Whitley",
           "Ronald Fenwick", "Judith Sayer", "Larry Mendel", "Brenda Coyle", "Wayne Ostrander", "Glenda Tate", "Russell Dunbar",
           "Marilyn Royce", "Eugene Pickard", "Bonnie Halvorsen", "Clifford Ames", "Joyce Marsh", "Vernon Stiles", "Frances Ludlow"],
    "es": ["Guadalupe Ríos", "Ernesto Salazar", "Rosalinda Cortés", "Javier Montoya", "Esperanza Villalobos", "Rubén Ochoa",
           "Leticia Barajas", "Arturo Medina", "Consuelo Ibarra"],
    "zh": ["Li Mei", "Wang Jun", "Zhang Hua", "Liu Fang", "Huang Wen"],
}
SHIFT_START = {1: "06:00", 2: "10:30", 3: "15:00"}


def home_point(town, center, ring, want_inside):
    for _ in range(200):
        lat = center[0] + rng.uniform(-0.013, 0.013)
        lng = center[1] + rng.uniform(-0.016, 0.016)
        if point_in_polygon(lng, lat, ring) == want_inside:
            return {"lat": round(lat, 4), "lng": round(lng, 4), "town": town}
    raise RuntimeError(f"no point for {town}")


def main():
    v0 = json.loads((SEED / "patients.json").read_text())[:5]
    ring = outage_ring(json.loads((SEED / "outage_area.geojson").read_text()))

    n = 35
    days = [["Mon", "Wed", "Fri"]] * 18 + [["Tue", "Thu", "Sat"]] * 17
    langs = ["en"] * 21 + ["es"] * 9 + ["zh"] * 5
    rides = ["paratransit"] * 6 + ["medical_van"] * 3 + ["wheelchair_van"] * 2 + ["family"] * 11 + ["self"] * 13
    inside = [True] * 11 + [False] * 24
    hep_b = [True] * 2 + [False] * 33
    flags = [["heart_failure"]] * 3 + [["missed_recently"]] * 2 + [["heart_failure", "missed_recently"]] + [[]] * 29
    for col in (langs, rides, inside, hep_b, flags):
        rng.shuffle(col)
    names = {k: list(v) for k, v in NAMES.items()}

    patients = list(v0)
    for i in range(n):
        pid = f"P{i + 6:03d}"
        d = days[i]
        shift = [1, 2, 3][i % 3]
        hours = rng.choice([3.5, 4, 4])
        towns = TOWNS_IN if inside[i] else TOWNS_OUT
        town = rng.choice(sorted(TOWNS_IN) if inside[i] else OUT_WEIGHTS)
        ride = rides[i]
        mobility = "wheelchair" if ride == "wheelchair_van" else rng.choice(["walker", "wheelchair"]) if ride in ("paratransit", "medical_van") else rng.choice(["walks", "walks", "walker"])
        last_day = "2026-10-26" if d[0] == "Mon" else "2026-10-24"
        patients.append({
            "id": pid,
            "name": names[langs[i]].pop(0),
            "days": d,
            "shift": shift,
            "hours": hours,
            "last_session": f"{last_day}T{SHIFT_START[shift]}:00-07:00",
            "home": home_point(town, towns[town], ring, inside[i]),
            "ride": ride,
            "lives_alone": rng.random() < 0.3,
            "language": langs[i],
            "mobility": mobility,
            "hep_b_positive": hep_b[i],
            "flags": flags[i],
            "callback": f"555-01{i + 6:02d}",
            "second_contact": rng.random() < 0.7,
        })
    (SEED / "patients.json").write_text(json.dumps(patients, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(patients)} patients written")


if __name__ == "__main__":
    main()
