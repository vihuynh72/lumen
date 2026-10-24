"""List in-center dialysis clinics near the home clinic, geocoded once.

Usage: python scripts/filter_cms.py OUT.json
Downloads the CMS "Dialysis Facility - Listing by Facility" rows for California, keeps in-center
hemodialysis clinics in El Dorado County and its neighbors (all within about 60 miles of
Cameron Park), and geocodes each address with the US Census geocoder. Write OUT.json outside
the repo; data/seed/clinics.json is picked from it by hand. Nothing geocodes at runtime.
"""

import csv
import io
import json
import sys
import urllib.parse
import urllib.request

CMS = "https://data.cms.gov/provider-data/api/1/datastore/query/23ew-n7w9/0"
CENSUS_BATCH = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
# shortcut: county list instead of a 60-mile radius; switch to a radius if the home clinic moves
COUNTIES = {"El Dorado", "Sacramento", "Placer", "Amador"}


def cms_rows():
    rows, offset = [], 0
    while True:
        query = urllib.parse.urlencode({
            "conditions[0][property]": "state", "conditions[0][value]": "CA", "conditions[0][operator]": "=",
            "limit": 500, "offset": offset,
        })
        page = json.load(urllib.request.urlopen(f"{CMS}?{query}", timeout=60))["results"]
        rows += page
        if len(page) < 500:
            return rows
        offset += 500


def geocode(rows):
    """One Census batch call. Returns {row index: (lat, lng)}."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    for i, r in enumerate(rows):
        writer.writerow([i, r["address_line_1"], r["citytown"], "CA", r["zip_code"]])
    boundary = "lumenboundary"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"benchmark\"\r\n\r\nPublic_AR_Current\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"addressFile\"; filename=\"a.csv\"\r\n"
            f"Content-Type: text/csv\r\n\r\n{buf.getvalue()}\r\n--{boundary}--\r\n").encode()
    req = urllib.request.Request(CENSUS_BATCH, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    out = {}
    for line in csv.reader(io.StringIO(urllib.request.urlopen(req, timeout=120).read().decode())):
        if len(line) > 5 and line[2] == "Match":
            lng, lat = line[5].split(",")
            out[int(line[0])] = (round(float(lat), 6), round(float(lng), 6))
    return out


def main(out_path):
    rows = [r for r in cms_rows() if r["countyparish"] in COUNTIES and r["offers_incenter_hemodialysis"] == "Yes"]
    coords = geocode(rows)
    clinics = [{
        "cms_id": r["cms_certification_number_ccn"],
        "name": r["facility_name"],
        "address": f"{r['address_line_1'].title()}, {r['citytown'].title()}, CA {r['zip_code']}",
        "county": r["countyparish"],
        "phone": r["telephone_number"],
        "stations": int(r["of_dialysis_stations"]),
        "late_shift": r["late_shift"] == "Yes",
        "chain": r["chain_organization"],
        "lat": coords.get(i, (None, None))[0],
        "lng": coords.get(i, (None, None))[1],
    } for i, r in enumerate(rows)]
    with open(out_path, "w") as f:
        json.dump(clinics, f, indent=2)
    print(f"{len(clinics)} clinics, {len(coords)} geocoded -> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1])
