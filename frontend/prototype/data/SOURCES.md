# Map data sources

- `transmission`, `substations`: real power lines (`power=line`) and substations from OpenStreetMap, fetched with the Overpass API on 2026-10-23. Lines that share tags are merged, clipped to the region box and simplified to about 10 m. OSM tag fields are left out when OSM has no value. Map data © OpenStreetMap contributors, ODbL.
- `footprints`: the OSM building that contains each facility, or the nearest one within 80 m (houses, sheds, buildings under 200 m² and buildings named for another business are skipped). When no building qualifies, the footprint is a 45 x 70 m rectangle with `source: "generated"` and `illustrative: true`.
- `feeders`: **illustrative**. A made-up street-style circuit from the nearest OSM substation to each facility. Real distribution circuits are not public.
- `in_outage` / `deenergized`: true when a line crosses the shutoff polygon, or a substation or a feeder's facility sits inside it. In Santa Clara that polygon (`outage`) is **illustrative**; in El Dorado it is `data/seed/outage_area.geojson`.
- Santa Clara `centers`: CMS Dialysis Facility file, positions approximate. `patients`: **synthetic** (`synthetic: true`), no real patient data. `zips`: Census ZCTA via OpenDataDE. `county`, `hoods`: click_that_hood. All copied from the old prototype.
- `affected` center = inside the shutoff zone and has more than 0 stations (same rule as the old prototype).
