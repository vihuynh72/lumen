"""Drive times from patient homes to clinics."""

import math


def haversine_km(lat1, lng1, lat2, lng2):
    la1, lo1, la2, lo2 = map(math.radians, (lat1, lng1, lat2, lng2))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def estimate(patients, clinics):
    """Straight-line km x 1.3 road factor at 50 km/h. {"P001": {"C01": {"minutes": 7, "source": "estimate"}}}"""
    return {
        p["id"]: {
            c["id"]: {"minutes": round(haversine_km(p["home"]["lat"], p["home"]["lng"], c["lat"], c["lng"]) * 1.3 / 50 * 60), "source": "estimate"}
            for c in clinics
        }
        for p in patients
    }


def drive_minutes(patients, clinics):
    # Location Service comes in VI-184; until then every drive time is the estimate.
    return estimate(patients, clinics)
