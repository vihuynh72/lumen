# Lumen app screen

The working screen of Lumen for the manager of DaVita Cameron Park Dialysis. It turns a PG&E Public Safety Power Shutoff notice into a patient-by-patient treatment plan that staff approve. Static files, no build step. Deploy the folder to AWS Amplify as is. Serve it locally on port 5173, for example `python3 -m http.server 5173 -d frontend/prototype`, and open http://localhost:5173/ (not 127.0.0.1: the map key works only on the allowed referrers).

## What the screen does

* **Top bar.** The home clinic, the region select, the event countdown, the theme toggle, the demo key, Reset and Run demo.
* **Left rail ("AI run").** Seven steps, each with its AWS service, its true source (model, rules fallback, rules or template fallback) and its server time:
  1. Read notice (`POST /alert`, Amazon Bedrock)
  2. Find affected, 3. Rank patients, 4. Assign chairs, 5. Write messages (one `POST /plan` call; the rail replays the steps with the real `timing_ms`)
  6. Approve (staff; the run waits for you)
  7. Voice notes (`POST /voice`, Amazon Polly)

  The re-plan box at the bottom sends a plain-language instruction (`POST /replan`) and adds a "Re-plan · vN" row. A failed step turns red, shows the API `error` and has a Retry button.
* **Map (center).** The shutoff area, live and de-energized feeders, transmission lines, the closed clinic, the affected patients and their new destinations. Each step moves the camera to what it changed. There are Home and 2D/3D controls and a legend.
* **Right panel.** Before a plan, it shows the home clinic and how the run works. After the notice, it shows the event. With a plan, it shows counts, the summary, Approve all, a filter, and the patient rows in rank order. Open a row to see its reasons, drive time, messages per language, Mark confirmed, Decline and Play voice note. After a re-plan, changed rows stay amber with a "Changed" note until you press Acknowledge changes.
* **Regions.** El Dorado County runs live against the API. Santa Clara County is an illustrative tour that runs in the page (`tour.js`) and makes no API calls.
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

The PG&E notice (`PSPS-DEMO-01`), the feeders and the Santa Clara shutoff area are illustrative. Transmission lines and substations come from OpenStreetMap. All patients are synthetic. The page labels each of these where it appears. Rules are demo assumptions, not clinical guidance.
