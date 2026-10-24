"""Write the synthetic patients of one region: the in-center hemodialysis patients of the clinics the shutoff closes.

Usage: python scripts/make_patients.py [eldorado|santaclara]   (default eldorado)
El Dorado writes data/seed/patients.json: 40 patients of DaVita Cameron Park. P001 to P005 are seed v0, unchanged
except for hbv_tested, so the contract fixtures still describe real roster patients; P006 to P040 are drawn.
Santa Clara writes data/seed/santaclara/patients.json: 96 patients, P101 to P196, 32 each of SHC Evergreen (C11),
SHC Silver Creek (C12) and SHC Santa Teresa (C17); each has clinic_id, its usual clinic.
Counts follow the patient research spec (US dialysis and county census figures, per 40, scaled to 96 for Santa
Clara); the fixed random seed makes each file the same on every run. Age is drawn only to keep fields consistent
and is not saved. Every patient has a session in the shutoff window.
"""

import json
import random
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
sys.path.insert(0, str(ROOT / "backend"))
from lumen.affected import find_affected, outage_ring, point_in_polygon  # noqa: E402

NOTICE_DAY = date(2026, 10, 26)
SHIFT_START = {1: "06:00", 2: "10:30", 3: "15:00", 4: "19:30"}
AGE_BANDS = [((22, 44), 11, 28), ((45, 64), 41, 39), ((65, 74), 26, 45), ((75, 89), 22, 48)]  # (ages, % of patients, % heart failure)
V0_HBV_TESTED = {"P001": "2026-10-07", "P002": "2026-10-14", "P003": "2026-10-02", "P004": "2026-08-11", "P005": "2026-10-19"}
COMMON = {  # counts out of 40, the same in both counties
    "days": {"MWF": 22, "TTS": 18}, "hours": {3: 4, 3.25: 6, 3.5: 12, 3.75: 8, 4: 10},
    "mobility": {"walks": 28, "walker": 8, "wheelchair": 4}, "heart_failure": 12, "missed_recently": 4,
    "second_contact": 34, "hbv_old": 4,
}
REGIONS = {
    "eldorado": {
        "dir": SEED, "first": 1, "kept": 5, "callback": 101, "rng": 20261026,
        "shift": {1: 14, 2: 14, 3: 10, 4: 2},  # shift 4: Cameron Park runs a late shift
        "ride": {"self": 10, "family": 19, "paratransit": 5, "medical_van": 5, "wheelchair_van": 1},
        "lives_alone": 8, "hep_b": 1, "inside": 13,
        # Real towns; homes are random points within about 1.5 km. Most outside homes are west or north of the area;
        # a few far-east homes (Pollock Pines) are over an hour from any open clinic.
        "towns_in": {"Cameron Park": (38.6688, -120.9872), "Shingle Springs": (38.6657, -120.9241), "Placerville": (38.7296, -120.7985),
                     "Diamond Springs": (38.6946, -120.8149), "El Dorado": (38.6824, -120.8463)},
        "towns_out": {"El Dorado Hills": (38.6857, -121.0822), "Pollock Pines": (38.7613, -120.5861), "Cool": (38.8871, -121.0145),
                      "Lotus": (38.8030, -120.9080), "Coloma": (38.8000, -120.8894)},
        "out_weights": ["El Dorado Hills"] * 4 + ["Cool"] * 2 + ["Lotus"] * 2 + ["Coloma"] * 2 + ["Pollock Pines"],
        "names": [(n, "en") for n in (
            "Dorothy Keane", "Harold Briggs", "Patricia Lowell", "Gary Holcomb", "Sharon Pruitt", "Dennis Archer", "Carol Whitley",
            "Ronald Fenwick", "Judith Sayer", "Larry Mendel", "Brenda Coyle", "Wayne Ostrander", "Glenda Tate", "Russell Dunbar",
            "Marilyn Royce", "Eugene Pickard", "Bonnie Halvorsen", "Clifford Ames", "Joyce Marsh", "Vernon Stiles", "Frances Ludlow",
            "Donna Whitaker", "Kenneth Rourke", "Sandra Ellison", "Ernesto Salazar", "Rosalinda Cortés", "Javier Montoya",
            "Rubén Ochoa", "Leticia Barajas", "Arturo Medina", "Rogelio Bautista", "Gloria Haynes", "Tanya Morrison", "Curtis Bell")]
            + [("Guadalupe Ríos", "es")],
    },
    "santaclara": {
        "dir": SEED / "santaclara", "first": 101, "kept": 0, "callback": 101, "rng": 20261027, "total": 96,
        "counts": {  # the per-40 spec x 2.4
            "days": {"MWF": 53, "TTS": 43}, "hours": {3: 10, 3.25: 14, 3.5: 29, 3.75: 19, 4: 24},
            "mobility": {"walks": 67, "walker": 19, "wheelchair": 10}, "heart_failure": 29, "missed_recently": 10,
            "second_contact": 82, "hbv_old": 10,
        },
        "ride": {"self": 24, "family": 43, "paratransit": 14, "medical_van": 12, "wheelchair_van": 3},
        "lives_alone": 14, "hep_b": 2,
        # 32 patients per closed clinic; homes are near their clinic. The shutoff zone covers the east foothills,
        # Evergreen, Silver Creek and Santa Teresa. Only SHC Santa Teresa runs a late shift.
        "clinics": {
            "C11": {"shift": {1: 11, 2: 12, 3: 9}, "inside": 11,
                    "towns_in": {"Evergreen": (37.3060, -121.7770), "East Foothills": (37.3550, -121.7700)},
                    "towns_out": {"East San Jose": (37.3356, -121.8303), "Alum Rock": (37.3730, -121.8451), "Berryessa": (37.4014, -121.8621)},
                    "out_weights": ["East San Jose"] * 3 + ["Alum Rock"] * 2 + ["Berryessa"]},
            "C12": {"shift": {1: 11, 2: 12, 3: 9}, "inside": 9,
                    "towns_in": {"Silver Creek": (37.2880, -121.7800), "Evergreen": (37.3060, -121.7770)},
                    "towns_out": {"Seven Trees": (37.2794, -121.8217), "East San Jose": (37.3356, -121.8303), "Fairgrounds": (37.3022, -121.8570)},
                    "out_weights": ["Seven Trees"] * 3 + ["East San Jose"] * 2 + ["Fairgrounds"]},
            "C17": {"shift": {1: 11, 2: 11, 3: 8, 4: 2}, "inside": 9,
                    "towns_in": {"Santa Teresa": (37.2300, -121.7700)},
                    "towns_out": {"Edenvale": (37.2670, -121.8200), "Blossom Valley": (37.2527, -121.8411), "Almaden": (37.2200, -121.8600)},
                    "out_weights": ["Edenvale"] * 3 + ["Blossom Valley"] * 2 + ["Almaden"]},
        },
        # Names follow the spec's county mix, scaled to 96: Hispanic 29, Vietnamese 12, Chinese 12, Filipino 10, Indian 2,
        # Korean 2, White 19, Black 5, Pacific Islander 2, other 3. Languages: en 72, es 10, vi 7, zh 7.
        "names": [(n, "es") for n in ("María Hernández", "José Ramírez", "Guadalupe Torres", "Jesús Mendoza", "Esperanza Morales",
                                      "Rigoberto Sánchez", "Consuelo Vargas", "Ignacio Herrera", "Graciela Domínguez", "Ernesto Villalobos")]
                 + [(n, "vi") for n in ("Thanh Nguyen", "Hoa Tran", "Minh Pham", "Dung Vo", "Phuong Dang", "Hung Bui", "Mai Do")]
                 + [(n, "zh") for n in ("Liu Mei", "Zhou Jian", "Wu Hong", "Zhang Hui", "Lin Fang", "Ma Jun", "Xu Ping")]
                 + [(n, "en") for n in (
                     "Carmen Gutiérrez", "Manuel Ortiz", "Rosa Navarro", "Alfredo Castillo", "Yolanda Ruiz", "Raúl Fuentes", "Teresa Aguilar",
                     "Gilberto Cervantes", "Patricia Lozano", "Ricardo Estrada", "Silvia Cabrera", "Arturo Rosales", "Elena Barrera",
                     "Héctor Valenzuela", "Lucía Ibarra", "Rafael Contreras", "Irma Zamora", "Fernando Salinas", "Norma Espinoza",
                     "Lan Le", "Tuan Huynh", "Quang Ngo", "Linh Ho", "Khanh Duong", "Kevin Lam", "Grace Wong", "Henry Chan", "Alice Leung",
                     "Raymond Tsai", "Rogelio Santos", "Teresita Reyes", "Danilo Cruz", "Corazon Bautista", "Ferdinand Mercado",
                     "Lourdes Villanueva", "Edgardo Aquino", "Marilou Pascual", "Renato Domingo", "Erlinda Soriano", "Suresh Reddy",
                     "Lakshmi Iyer", "Soon-ja Kim", "Young-ho Cho", "Barbara Kowalski", "Richard Lindgren", "Nancy Sorensen",
                     "Michael Doherty", "Carol Brennan", "Steven Albright", "Diane Fischer", "Paul Mancini", "Janet Ostrowski",
                     "Gerald Hoffman", "Kathleen Murphy", "Dale Christensen", "Sheila Novak", "Roger Pellegrini", "Debra Lundquist",
                     "Frank DeLuca", "Margaret Sullivan", "Thomas Becker", "Joan Whitmore", "Darnell Brooks", "Loretta Simmons",
                     "Cedric Washington", "Yvonne Jefferson", "Bernard Coleman", "Sione Tupou", "Malia Fifita", "Jordan Ellis",
                     "Samira Haddad", "Farid Rahimi")],
    },
}


def pick(rng, ids, k, weight=lambda i: 1):
    """k ids drawn without replacement, each in proportion to weight(id)."""
    return sorted(ids, key=lambda i: rng.random() ** (1 / weight(i)), reverse=True)[:k]


def spread(counts):
    return [value for value, n in counts.items() for _ in range(n)]


def home_point(rng, town, center, ring, want_inside):
    for _ in range(200):
        lat = center[0] + rng.uniform(-0.013, 0.013)
        lng = center[1] + rng.uniform(-0.016, 0.016)
        if point_in_polygon(lng, lat, ring) == want_inside:
            return {"lat": round(lat, 4), "lng": round(lng, 4), "town": town}
    raise RuntimeError(f"no point for {town}")


def make(region):
    cfg = REGIONS[region]
    rng = random.Random(cfg["rng"])
    path = cfg["dir"] / "patients.json"
    polygon = json.loads((cfg["dir"] / "outage_area.geojson").read_text())
    ring = outage_ring(polygon)
    kept = [{**p, "hbv_tested": V0_HBV_TESTED[p["id"]]} for p in json.loads(path.read_text())[:cfg["kept"]]] if cfg["kept"] else []
    groups = cfg.get("clinics")  # per-clinic shifts and homes; None: every patient is the home clinic's
    total = cfg.get("total", 40)
    if groups:
        cfg = {**cfg, "shift": dict(sum((Counter(g["shift"]) for g in groups.values()), Counter())),
               "inside": sum(g["inside"] for g in groups.values())}
    target = {**COMMON, **cfg.get("counts", {}), **{k: cfg[k] for k in ("shift", "ride", "lives_alone", "hep_b", "inside")}}

    def left(field, value_of):  # the target counts minus what the kept patients already have
        have = Counter(value_of(p) for p in kept)
        return {v: n - have[v] for v, n in target[field].items()}

    def left_n(field, test):
        return target[field] - sum(map(test, kept))

    names = list(cfg["names"])
    rng.shuffle(names)
    ids = list(range(len(names)))
    assert len(ids) + len(kept) == total
    clinic = {i: list(groups)[i * len(groups) // len(ids)] for i in ids} if groups else {}  # names are shuffled: an even split
    age = {}
    for i in ids:
        (lo, hi), = rng.choices([b[0] for b in AGE_BANDS], weights=[b[1] for b in AGE_BANDS])
        age[i] = rng.randint(lo, hi)
        if names[i][1] != "en" and age[i] < 55:  # limited English is more common in older adults
            age[i] = rng.randint(55, 79)
    band = {i: next(b for b in AGE_BANDS if b[0][0] <= age[i] <= b[0][1]) for i in ids}
    older = lambda i: 4 if age[i] >= 65 else 1  # noqa: E731

    need = left("mobility", lambda p: p["mobility"])
    mobility = dict.fromkeys(ids, "walks")
    for i in pick(rng, ids, need["wheelchair"], older):
        mobility[i] = "wheelchair"
    for i in pick(rng, [i for i in ids if mobility[i] == "walks"], need["walker"], older):
        mobility[i] = "walker"

    need = left("ride", lambda p: p["ride"])
    ride = {}
    chairs = [i for i in ids if mobility[i] == "wheelchair"]
    for i in pick(rng, chairs, need.pop("wheelchair_van")):
        ride[i] = "wheelchair_van"
    for i in pick(rng, [i for i in ids if mobility[i] == "walks" and age[i] < 75], need.pop("self")):  # self: under 75 and walks
        ride[i] = "self"
    rest = spread(need)
    rng.shuffle(rest)
    for i in chairs:  # a wheelchair user rides a wheelchair van, paratransit or with family
        if i not in ride:
            ride[i] = rest.pop(next(n for n, v in enumerate(rest) if v in ("paratransit", "family")))
    for i in ids:
        if i not in ride:
            ride[i] = rest.pop()

    alone = set(pick(rng, ids, left_n("lives_alone", lambda p: p["lives_alone"]),
                     lambda i: 3 if ride[i] in ("paratransit", "medical_van", "self") else 1))
    heart = set(pick(rng, ids, left_n("heart_failure", lambda p: "heart_failure" in p["flags"]), lambda i: band[i][2]))
    missed = set(pick(rng, ids, left_n("missed_recently", lambda p: "missed_recently" in p["flags"])))
    hep_b = set(pick(rng, ids, left_n("hep_b", lambda p: p["hep_b_positive"])))
    second = set(pick(rng, ids, left_n("second_contact", lambda p: p["second_contact"])))
    hbv_old = set(pick(rng, [i for i in ids if i not in hep_b],
                       left_n("hbv_old", lambda p: p["hbv_tested"] < (NOTICE_DAY - timedelta(days=30)).isoformat())))
    days = spread(left("days", lambda p: "MWF" if p["days"][0] == "Mon" else "TTS"))
    hours = spread(left("hours", lambda p: p["hours"]))
    if groups:
        inside, shifts = set(), [0] * len(ids)
        for cid, g in groups.items():
            mine = [i for i in ids if clinic[i] == cid]
            inside |= set(pick(rng, mine, g["inside"]))
            col = spread(g["shift"])
            rng.shuffle(col)
            for i, shift in zip(mine, col):
                shifts[i] = shift
        rng.shuffle(days)
        rng.shuffle(hours)
    else:
        inside = set(pick(rng, ids, left_n("inside", lambda p: point_in_polygon(p["home"]["lng"], p["home"]["lat"], ring))))
        shifts = spread(left("shift", lambda p: p["shift"]))
        for col in (days, shifts, hours):
            rng.shuffle(col)
    # A Tue/Thu/Sat 3 PM session of 3 hours ends at 6 PM, exactly when the power goes off, and misses the window:
    # swap its hours with a patient whose session is affected either way.
    late_tts = lambda i: days[i] == "TTS" and shifts[i] == 3  # noqa: E731
    for i in ids:
        if late_tts(i) and hours[i] == 3:
            j = next(j for j in ids if hours[j] != 3 and not late_tts(j))
            hours[i], hours[j] = hours[j], hours[i]

    patients = list(kept)
    for i in ids:
        n = cfg["first"] + len(kept) + i
        mwf = days[i] == "MWF"
        area = groups[clinic[i]] if groups else cfg
        town = rng.choice(sorted(area["towns_in"])) if i in inside else rng.choice(area["out_weights"])
        towns = area["towns_in"] if i in inside else area["towns_out"]
        tested = NOTICE_DAY - timedelta(days=rng.randint(45, 150) if i in hbv_old else rng.randint(3, 25))
        patients.append({
            "id": f"P{n:03d}",
            **({"clinic_id": clinic[i]} if groups else {}),
            "name": names[i][0],
            "days": ["Mon", "Wed", "Fri"] if mwf else ["Tue", "Thu", "Sat"],
            "shift": shifts[i],
            "hours": hours[i],
            "last_session": f"{'2026-10-26' if mwf else '2026-10-24'}T{SHIFT_START[shifts[i]]}:00-07:00",
            "home": home_point(rng, town, towns[town], ring, i in inside),
            "ride": ride[i],
            "lives_alone": i in alone,
            "language": names[i][1],
            "mobility": mobility[i],
            "hep_b_positive": i in hep_b,
            "flags": [f for f, on in (("heart_failure", i in heart), ("missed_recently", i in missed)) if on],
            "callback": f"555-0{cfg['callback'] + len(kept) + i}",
            "second_contact": i in second,
            "hbv_tested": tested.isoformat(),
        })

    # Self-check: every total hits the spec, and related fields agree.
    count = lambda test: sum(map(test, patients))  # noqa: E731
    assert Counter(p["ride"] for p in patients) == Counter(target["ride"])
    assert Counter(p["mobility"] for p in patients) == Counter(target["mobility"])
    assert Counter(p["shift"] for p in patients) == Counter(target["shift"])
    assert count(lambda p: p["days"][0] == "Mon") == target["days"]["MWF"]
    assert count(lambda p: p["lives_alone"]) == target["lives_alone"] and count(lambda p: p["hep_b_positive"]) == target["hep_b"]
    assert count(lambda p: "heart_failure" in p["flags"]) == target["heart_failure"]
    assert count(lambda p: "missed_recently" in p["flags"]) == target["missed_recently"]
    assert count(lambda p: point_in_polygon(p["home"]["lng"], p["home"]["lat"], ring)) == target["inside"]
    assert not any(p["mobility"] == "wheelchair" and p["ride"] in ("self", "medical_van") for p in patients)
    assert len({p["name"] for p in patients}) == total and len({p["callback"] for p in patients}) == total
    clinics = json.loads((cfg["dir"] / "clinics.json").read_text())
    late = {c["id"] for c in clinics if c["late_shift"]}
    home = next(c["id"] for c in clinics if c["home"])
    assert all(p.get("clinic_id", home) in late for p in patients if p["shift"] == 4), "shift 4 only at a late-shift clinic"
    window = {"start": "2026-10-27T18:00:00-07:00", "end": "2026-10-29T12:00:00-07:00"}  # both notices
    affected = find_affected(window, clinics, patients, polygon, datetime.fromisoformat("2026-10-26T09:00:00-07:00"))
    assert {s["patient_id"] for s in affected["sessions"]} == {p["id"] for p in patients}, "every patient has a session in the window"
    path.write_text(json.dumps(patients, indent=2, ensure_ascii=False) + "\n")
    print(f"{region}: {len(patients)} patients written to {path.relative_to(ROOT)}")


if __name__ == "__main__":
    make(sys.argv[1] if len(sys.argv) > 1 else "eldorado")
