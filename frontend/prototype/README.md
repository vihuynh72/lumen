# Lumen app screen

The working screen of Lumen for the manager of DaVita Cameron Park Dialysis. It turns a PG&E Public Safety Power Shutoff notice into a patient-by-patient treatment plan that staff approve. Static files, no build step. Deploy the folder to AWS Amplify as is. Serve it locally on port 5173, for example `python3 -m http.server 5173 -d frontend/prototype`, and open http://localhost:5173/ (not 127.0.0.1: the map key works only on the allowed referrers).

## What the screen does

* **Top bar.** The home clinic, the region select, the event countdown (labeled "Simulated PG&E notice"), the theme toggle, the demo key, Reset and Run demo. When a plan exists, Run demo first asks "Start over?", because a new run deletes the plan, its approvals and its voice notes.
* **Left rail ("AI run").** Seven steps and a "Step N of 7" line. Each step shows the service that did the work, its source and its time. The chip follows the API's `parse_source` and `ai_sources`: "Amazon Bedrock · Claude Haiku 4.5" when Bedrock did the step, "AWS Lambda · Rules fallback (or Template fallback) · Bedrock unavailable" when the rules did it, "AWS Lambda · Source not reported" when the API does not say. Times under 1 ms print "<1 ms".
  1. Read notice (`POST /alert`; Bedrock when available, otherwise rules). The time is the browser round trip.
  2. Find affected, 3. Rank patients, 4. Assign chairs, 5. Write messages. All four come from one `POST /plan` request; the rail replays them with the real server `timing_ms`, and holds the home grid in 3D for about 2.6 s after Find affected.
  6. Approve (staff; the run waits for you)
  7. Voice notes (`POST /voice`, Amazon Polly; the time is the browser round trip)

  A done step keeps one result line; press it to open its details. The re-plan box at the bottom sends a plain-language instruction (`POST /replan`) and adds a "Re-plan · vN" step. The rail scrolls to the newest step, the map shows the plan routes with the changed ones in amber, and the panel scrolls to the first changed row. If the re-plan returns draft rows, Approve waits for you again. A failed step turns red, shows the API `error` and has a Retry button.
* **Map (center).** The shutoff area, live and de-energized feeders, transmission lines, the closed clinic, the affected patients and one route per destination (the number on a route counts its patients; staff calls are dashed; early sessions stay at their own clinic and have no route). Red means power off only. Each step moves the camera to what it changed. Controls: Whole plan (after the plan), Home and 3D. The legend matches the map, opens by default when the map is at least 900 px wide, and has a Pause animation button for the moving feeder current. Map fits leave room for the legend, the controls and an open drawer or sheet.
* **Right panel.** Before a plan, it shows the home clinic (its power state comes from Find affected) and how the run works. After the notice, it shows the event. With a plan, it shows counts, the summary, Approve all, a filter, and the patient rows in rank order. Open a row to see its reasons, drive time, messages per language, Mark confirmed (after approval only), Decline and Play voice note (after the row is confirmed). After a re-plan, changed rows stay amber with a "Changed" note until you press Acknowledge changes or reload.
* **Regions.** El Dorado County runs live against the API. Santa Clara County is an illustrative tour that runs in the page (`tour.js`) and makes no API calls; its steps carry the chip "In this page" and the source "Illustrative tour".
* A page reload restores the live state from `GET /state`.

Below 1180 px wide, the plan panel is a drawer (Plan button). Below 760 px, the rail is a top sheet and the plan a bottom sheet.

## Files

| File | What |
| -- | -- |
| `index.html` | Markup, `LUMEN_CONFIG`, script order |
| `app.css` | Design tokens (light and dark, map colors) and layout |
| `app.js` | API client, demo runner, rail, plan panel, controls |
| `map.js` | `window.LumenMap` (MapLibre GL JS 4.7.1) |
| `tour.js` | `window.LumenTour`, the Santa Clara tour computed in the page |
| `data/eldorado.json`, `data/santaclara.json` | Map data. See `data/SOURCES.md` |

## Configuration

`window.LUMEN_CONFIG` in `index.html`:

* `api`: the Lambda function URL. The contract is `contracts/api.md`.
* `mapKey`: the Amazon Location Service API key. The map uses Amazon Location Service (style Monochrome, us-east-2) with a referrer-restricted API key. The page falls back to OpenFreeMap tiles when the key or the style fails.

The demo key is not in the repo. Open the key button in the top bar, paste the key and press Save. The page stores it in `localStorage` (`lumenDemoKey`) and sends it as `x-demo-key`. Ask the team for it.

## Data and labels

The PG&E notice (`PSPS-DEMO-01`) is simulated, and the page says so wherever it shows it. The feeders, their de-energized state and the Santa Clara shutoff area are illustrative. Transmission lines and substations come from OpenStreetMap. All patients are synthetic. The page labels each of these where it appears. Rules are demo assumptions, not clinical guidance.
