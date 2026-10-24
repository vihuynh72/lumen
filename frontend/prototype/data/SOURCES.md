# Map data sources

- `transmission`, `substations`: real power lines (`power=line`) and substations from OpenStreetMap, fetched with the Overpass API on 2026-10-23. Lines that share tags are merged, clipped to the region box and simplified to about 10 m. OSM tag fields are left out when OSM has no value. Map data © OpenStreetMap contributors, ODbL.
- `footprints` and `feeders` follow the backend seed's facility IDs (El Dorado C01-C06, H01; Santa Clara C11-C34, H11; Santa Clara rebuilt 2026-10-24 for the v6 seed).
- `footprints`: the OSM building that contains each facility, or the nearest one within 80 m (houses, sheds, buildings under 200 m² and buildings named for another business are skipped). When no building qualifies, the footprint is a 45 x 70 m rectangle with `source: "generated"` and `illustrative: true`.
- `feeders`: **illustrative**. A made-up street-style circuit from the nearest OSM substation to each facility. Real distribution circuits are not public.
- `in_outage` / `deenergized`: true when a line crosses the shutoff polygon, or a substation or a feeder's facility sits inside it. In both counties it is the backend seed's simulated shutoff area (`data/seed/outage_area.geojson`, `data/seed/santaclara/outage_area.geojson`).
- Santa Clara `county`: click_that_hood, copied from the old prototype.
- `replay/santaclara.json` and `replay/audio/`: one live Santa Clara run of the deployed API (alert, plan, check, approve, voice notes, clinic sheets, the simulated replies and the two re-plan suggestions) and three of its Amazon Polly voice notes, recorded for the console's no-key demo. Synthetic patients; the notice, the sends and the replies are simulated.
