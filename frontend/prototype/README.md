# Lumen console

The working screen of Lumen for the manager of DaVita Cameron Park Dialysis. It turns a PG&E Public Safety Power Shutoff notice into a plan for each patient, and one press tells every patient and clinic. Static files, no build step. Deploy the folder to AWS Amplify as is. Serve it locally on port 5173, for example `python3 -m http.server 5173 -d frontend/prototype`, and open http://localhost:5173/console.html (not 127.0.0.1: the map key works only on the allowed referrers). `index.html` is the landing page.

## The flow (CONTRACT-v5)

1. **Plan made.** Run demo plays one hands-free run (about 40 seconds, Pause and Resume in the rail): the simulated notice arrives (`POST /alert`), the shutoff area draws in, the camera flies into the home clinic as it loses power, the patients' homes appear, then the map searches the nearby clinics nearest first (`LumenMap.searchGraph`) and traces one road route to each clinic that takes patients while its count goes up (`POST /plan` runs during the first scenes). The rail shows the 8 steps and the timeline bar at the bottom of the map is the run's clock. After the run the timeline goes, and the rail folds to 3 stages: Plan made, Approve and tell, Everyone told. "How this plan was made" opens the 8 steps again.
2. **Approve and tell.** The panel holds one sentence ("36 patients have a chair. 4 need a phone call from you."), the plan check verdict (`POST /check`, in the background), one button, Review and approve, and "Where they go". The button opens the review list (`review.js`): patients grouped by where they go, a "Tell clinic" switch per clinic and a "Voice note" switch per patient, all on (a patient the check says to phone starts off). "Approve and tell everyone" approves the rows (`POST /approve`), sends the voice notes (`POST /notify`) and sends each clinic and the hospital its patients' sheets (`POST /packet`). All of it is simulated: nothing leaves Lumen. The list never opens by itself.
3. **Everyone told.** Simulated replies come in over about 20 seconds (saved with `POST /approve` edits): most patients say yes; patients who missed a treatment recently, or live alone with a pickup before 6 AM, do not answer. Each told clinic confirms its chairs. The done board counts chairs, patients told, clinics told and rides to book, then lists "Needs you now, soonest first" with each callback number. "Print the list" prints the board.

"Something changed?" in the rail sends a change in plain words (`POST /replan`), for example "DaVita Folsom can only take 4 more" or "Maria Delgado declined". Changed patients go back to "To approve".

## Screen

* **Top bar.** Lumen, the home clinic, the county menu (El Dorado, Santa Clara), "Power off in 33 hours", Run demo and one Demo menu (Reset the demo, Demo key, theme). When a plan exists, Run demo first asks "Start over?".
* **Map.** After the plan it keeps a few marks: the shutoff area, the home clinic, each receiving clinic ("DaVita Folsom · 9 patients", "Full"), one road route to each, and the hospital when it has patients. The power grid shows only while the clinic loses power. A patient or a "Where they go" row shows only that path; Esc or "Show all routes" shows them all again.
* **Road routes.** Computed live in the browser with Amazon Location Routes v2 (`mapKey`), at most 4 requests at once, one retry, cached for the page session only. A failed route is a dashed straight line labeled "Road route not available".
* **Words.** Plain words only: To approve, Told, Said yes, No answer, chairs, needs a phone call. No source, model or service labels anywhere on screen.
* Above 1180 px the rail and the panel resize (drag, or the arrow keys on the line; double-click resets; saved in `localStorage`). Below 1180 px the plan is a drawer (Plan button); below 760 px the rail is a top sheet. The first visit follows the system light or dark setting; the Demo menu's theme choice is saved. Reduced motion makes every scene instant, in the same order.

## Regions

Both counties use the live API, with `&region=eldorado` or `&region=santaclara` on every call. Without a demo key, or while the API does not know Santa Clara yet, Santa Clara plays an in-page tour (`tour.js`, "Simulated outage").

## Files

| File | What |
| -- | -- |
| `console.html` | Markup, `LUMEN_CONFIG`, script order |
| `app.css` | Design tokens (light and dark, map colors) and layout |
| `app.js` | API client, the run, rail, panel, approve and tell, simulated replies, done board, road routes |
| `map.js` | `window.LumenMap` (MapLibre GL JS 4.7.1) |
| `review.js`, `review.css` | `window.LumenReview`, the approve and tell list |
| `timeline.js`, `timeline.css` | `window.LumenTimeline`, the run's clock |
| `tour.js` | `window.LumenTour`, the Santa Clara tour computed in the page |
| `index.html`, `landing.css`, `landing.js` | The landing page |
| `data/eldorado.json`, `data/santaclara.json` | Map data. See `data/SOURCES.md` |

## Configuration

`window.LUMEN_CONFIG` in `console.html`:

* `api`: the API base URL. The contract is `contracts/api.md`.
* `mapKey`: the Amazon Location Service API key (style Monochrome, us-east-2), referrer-restricted. The page falls back to OpenFreeMap tiles when the key or the style fails. Road routes use it too (`geo-routes:CalculateRoutes`).

The demo key is not in the repo. Open Demo, then Demo key, paste the key and press Save. The page keeps it in `localStorage` (`lumenDemoKey`) and sends it as `x-demo-key`. Ask the team for it.

## Data and labels

The PG&E notice and the replies are simulated, and the page says so. The feeders and the shutoff areas are illustrative. Transmission lines and substations come from OpenStreetMap. All patients are synthetic. The plan follows demo assumptions, not clinical guidance.
