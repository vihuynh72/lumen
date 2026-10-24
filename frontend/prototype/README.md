# Lumen console

The working screen of Lumen for a dialysis clinic administrator. It turns a PG&E Public Safety Power Shutoff notice into a plan for each patient, and one press tells every patient and clinic. Static files, no build step. Deploy the folder to AWS Amplify as is. Serve it locally on port 5173, for example `python3 -m http.server 5173 -d frontend/prototype`, and open http://localhost:5173/ (not 127.0.0.1: the map key works only on the allowed referrers). `index.html` is the landing page; its **Try the live demo** opens `console.html`, the console.

## The flow (CONTRACT-v6)

The rail shows all 8 steps, each with one result line, during and after the run: Read the PG&E notice · Find who is affected · Put the most urgent first · Find open slots · Write patient messages · Check the plan · Approve and tell everyone · Everyone told.

1. **Plan made.** Only Run demo starts the run; the console never starts it by itself. The run plays hands-free (Pause and Resume in the rail): the simulated notice arrives (`POST /alert`), the shutoff area draws in, the camera flies into the home clinic as it loses power, the patients' homes appear, then the map searches the nearby clinics that have a free slot, nearest first, one closed clinic after another (`LumenMap.searchGraph`, under about 10 seconds), and traces one road route from each closed clinic to each clinic that takes its patients while the counts go up (`POST /plan` runs during the first scenes). The timeline bar at the bottom of the map is the run's clock and shows only during the run. The run stops at step 7, "Approve and tell everyone", and waits for staff; the camera then fits the whole plan, every clinic and route in view.
2. **Approve and tell.** The panel holds one sentence ("92 patients have a slot. 4 need a phone call from you."), the plan check verdict (`POST /check`, in the background), one button, Review and approve, and "Where they go" (each receiving clinic with its patients and slots left, or Full; Come in early here; Need a phone call). The button opens the review list (`review.js`): patients grouped by where they go, a "Tell clinic" switch per clinic and a "Voice note" switch per patient, all on (a patient the check says to phone starts off). "Approve and tell everyone" approves the rows (`POST /approve`), sends the voice notes (`POST /notify`) and sends each clinic and the hospital its patients' sheets (`POST /packet`). All of it is simulated: nothing leaves Lumen. The list never opens by itself. While it runs, Run demo, Reset and the county menu are off.
3. **Everyone told.** Simulated replies come in over about 20 seconds (saved with `POST /approve` edits): most patients say yes; patients who missed a treatment recently, or live alone with a pickup before 6 AM, do not answer. Each told clinic confirms its slots. Step 8 fills in as they land ("33 of 36 said yes · 3 to call"). The done board counts slots, patients told, clinics told and rides to book, then lists "Needs you now, soonest first" with each callback number. "Print the list" prints the board. When a reply loses a race with another write (409), the console loads the plan once and goes on.

"Something changed?" in the rail sends a change in plain words (`POST /replan`). The two suggestion chips name a receiving clinic and a patient: "DaVita Folsom can only take 4 more" and "Maria Delgado declined" in El Dorado; in Santa Clara the busiest receiving clinic and the first moved patient, for example "DaVita Tully can only take 4 more" and "Richard Lindgren declined". Changed patients go back to "To approve".

## What patients and clinics receive (v6 section 4)

One panel view over the plan; Back or Esc closes it, and there is no new route. Plain cards, no phone or fax chrome.

* **A patient** (a patient on the map, in a clinic's list or in "Needs you now"): "What {name} gets", with the patient's full name (the review card says the same). The message as one text-message bubble in the patient's language, with a tab for English too; the line under it says when it went out and the reply (Told 9:02 AM · Said yes, No answer, Said no). Play voice note uses Amazon Polly in English, Spanish and Chinese; other languages show "Voice in English". A patient with no message reads "No text message. Staff phone {first name}." with the callback number.
* **A clinic or the hospital** (a row in "Where they go", a clinic on the done board, or the place on the map): "What {clinic} gets". To (the place and its address), From (the home clinic and the callback line), "N patients arriving" ("may arrive" for the hospital), one row per patient (name, day and time, ride, hepatitis B test date, language), "Reply YES to confirm these slots." ("Reply YES if you can take them." for the hospital) and the status ("Told 9:02 AM · Confirmed 9 slots"). It reads the plan rows and their sheets (`packet`).

## Screen

* **Top bar.** Lumen, the home clinic, the county menu (Santa Clara County, El Dorado County), "Power off in 33 hours", Run demo and one Demo menu (Reset the demo, Demo key, theme). When a plan exists, Run demo first asks "Start over?".
* **Map.** After the plan it keeps a few marks: the shutoff area, the home clinic, each receiving clinic ("16 of 18 slots", or "Full"), one road route to each, and the hospital when it has patients. The power grid shows only while the clinics lose power; the legend hides after the plan. A patient or a "Where they go" row shows only that path; Esc or "Show all routes" shows them all again.
* **Road routes.** Computed live in the browser with Amazon Location Routes v2 (`mapKey`), at most 4 requests at once, one retry, cached for the page session only. A failed route is a dashed straight line labeled "Road route not available".
* **Words.** Plain words only: To approve, Told, Said yes, No answer, slots, needs a phone call. No source, model or service labels anywhere on screen.
* Above 1180 px the rail and the panel resize (drag, or the arrow keys on the line; double-click resets; saved in `localStorage`). Below 1180 px the plan is a drawer (Plan button); below 760 px the rail is a top sheet. The first visit follows the system light or dark setting; the Demo menu's theme choice is saved. Reduced motion makes every scene instant, in the same order.

## Regions

The console opens on Santa Clara County and keeps the county chosen in the menu across reloads (`localStorage` `lumenRegion`). With the demo key both counties use the live API, with `&region=santaclara` or `&region=eldorado` on every call. Without it, Santa Clara plays the replay below.

* **Santa Clara.** The shutoff closes three clinics: SHC Evergreen (the home clinic), SHC Silver Creek and SHC Santa Teresa. 96 synthetic patients have a treatment in the window: 17 come in early, 75 move to 7 clinics, and 4 need a phone call (Regional Medical Center gets their sheets).
* **El Dorado.** DaVita Cameron Park Dialysis closes. 40 synthetic patients: 8 come in early, 28 move to 3 clinics, and 4 need a phone call.

### Without a demo key: the replay

Santa Clara without a key replays one recorded live run through the same screens (`replayBackend` in `app.js`); El Dorado asks for the key. The console makes no API call in the replay.

* `data/replay/santaclara.json` holds what the deployed API answered in one Santa Clara run, in the console's order: `GET /state` before and after, `POST /alert`, `/plan`, `/check`, `/approve`, `/notify`, `/packet`, the simulated reply writes, and the two Santa Clara suggestion chips' `/replan` answers (both read by the model). It holds no key and no signed link.
* `/alert`, `/plan`, `/check` and the chips give the recorded answers. Approve, voice notes and clinic sheets apply to the recorded plan in the page, so the switches in "Approve and tell everyone" still choose who is told, and the simulated replies write through approve as they do live. A chip's changed patients replace theirs, as the API does. Any other change reads "In the demo without a key, try one of the suggestions."
* `data/replay/audio/` holds three recorded voice notes (Amazon Polly): Ma Jun (Chinese), Ignacio Herrera (Spanish) and Roger Pellegrini (English). Other voice notes say "Voice notes play in the live demo."
* To record it again: with the demo key, call the API in this order with a new `?session=` and `&region=santaclara`, save the answers in the same shape, and download the three notes from `/voice` (its links expire, so keep the files, never the links).

## Files

| File | What |
| -- | -- |
| `console.html` | Markup, `LUMEN_CONFIG`, script order |
| `app.css` | Design tokens (light and dark, map colors) and layout |
| `app.js` | API client, the run, rail, panel, approve and tell, simulated replies, done board, road routes |
| `map.js` | `window.LumenMap` (MapLibre GL JS 4.7.1) |
| `review.js`, `review.css` | `window.LumenReview`, the approve and tell list |
| `timeline.js`, `timeline.css` | `window.LumenTimeline`, the run's clock |
| `index.html`, `landing.css`, `landing.js` | The landing page |
| `data/eldorado.json`, `data/santaclara.json` | Map data (power lines, substations, feeders, buildings, county line). See `data/SOURCES.md` |
| `data/replay/` | The recorded Santa Clara run and its three voice notes, for the no-key replay |

## Configuration

`window.LUMEN_CONFIG` in `console.html`:

* `api`: the API base URL. The contract is `contracts/api.md`.
* `mapKey`: the Amazon Location Service API key (style Monochrome, us-east-2), referrer-restricted. The page falls back to OpenFreeMap tiles when the key or the style fails. Road routes use it too (`geo-routes:CalculateRoutes`).

The demo key is not in the repo. Open Demo, then Demo key, paste the key and press Save. The page keeps it in `localStorage` (`lumenDemoKey`) and sends it as `x-demo-key`. Ask the team for it.

## Data and labels

The PG&E notice, the sends and the replies are simulated, and the page says so. The no-key replay is a recording of one live run, not a second version of the plan. Open slots are simulated. The feeders and the shutoff areas are illustrative. Transmission lines and substations come from OpenStreetMap. All patients are synthetic. The plan follows demo assumptions, not clinical guidance.
