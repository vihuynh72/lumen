# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static pages in `frontend/prototype/` (`index.html`, the landing page, then `console.html`) with no build step, deployed to AWS Amplify by manual upload. Libraries come from CDNs. The API is one Lambda function URL (`contracts/api.md`).

## Users

The primary user is a dialysis clinic administrator: Rosa, the manager of SHC Evergreen (the home clinic, `C11`, in Santa Clara County, where the console opens; in El Dorado County the home clinic is DaVita Cameron Park Dialysis, `C01`). She is 61, runs facility operations, is not a clinician at the chair or a technical person, and works under time pressure. The team calls this audience "hospital administrators".

Their situation: PG&E sends a Public Safety Power Shutoff (PSPS) warning about 48 hours before it cuts power. Before the shutoff starts, the administrator must find out which patients miss a treatment, find each one another slot, and tell every patient and every receiving clinic. In the Santa Clara demo the shutoff closes three clinics (SHC Evergreen, SHC Silver Creek and SHC Santa Teresa), and the home clinic plans for the 96 patients of all three.

Secondary audience: hackathon judges (SpartHill Hackathon 2026, AWS track) who watch a recorded or live demo.

## Product Purpose

Lumen helps people who depend on electricity get through planned power shutoffs: dialysis, home oxygen, ventilators, medicine that must stay cold, power wheelchairs. The demo shows dialysis clinics only; Lumen does not serve the other groups yet.

Lumen turns a PSPS notice into a patient-by-patient treatment plan, gets one approval, and tells everyone. It reads the notice, finds the closed clinics and the affected sessions, ranks patients by urgency, gives each patient the nearest clinic with a free slot at their time (an early session at their own clinic, a transfer, or a phone call from staff when no slot fits), writes patient messages and checks the plan. One press then sends each patient a voice note in their language and tells each receiving clinic and the hospital who is coming, with each patient's sheet. Staff can open what each patient and each clinic receives. These sends and the replies are simulated.

Success: before the shutoff, every affected patient has a confirmed slot or a phone call from staff, everyone is told, and the administrator sees at a glance who still needs a call.

## Positioning

AI reads and explains, rules decide, people approve. A model on Amazon Bedrock reads the notice, rewords the plan check into plain sentences, and reads plain-language re-plan instructions into changes that code checks and applies. Deterministic code ranks patients, picks slots, checks capacity and decides who gets a voice note. No message goes out without staff approval. The screen shows no source or model labels, and never claims AI that did not run.

## Operating Context

* The administrator works from the home facility on a desktop or laptop, during office hours, under time pressure.
* The map shows the home facility and the shutoff area first. Power lines show only in the run's "loses power" scene.
* The demo runs on the deployed Amplify URL with a demo key, recorded at 1920 x 1080, and also on a laptop for judges.
* Regions: Santa Clara County (San Jose; the console opens here and remembers the county chosen in its menu) and El Dorado County (Cameron Park, Folsom, Rancho Cordova). Both run on the live API (`?region=santaclara|eldorado`; the API's default is `eldorado`).
* Map tiles: Amazon Location Service (Monochrome style, us-east-2) with a referrer-restricted API key. The page falls back to OpenFreeMap tiles if that style fails to load.

## Capabilities and Constraints

* API routes: `GET /state`, `POST /alert`, `/plan`, `/check`, `/approve`, `/replan`, `/notify`, `/packet`, `/voice`, `/speak`, `/reset`. Header `X-Demo-Key` on every request. Optional `?session=` (each browser tab has its own plans) and `?region=`.
* The rail shows all eight steps, each with one result line, during and after the run: Read the PG&E notice · Find who is affected · Put the most urgent first · Find open slots · Write patient messages · Check the plan · Approve and tell everyone · Everyone told.
* The flow has three stages. 1 Plan made: only Run demo starts the run. It plays hands-free (notice, shutoff area, the clinics lose power, nearest-first search, routes traced, messages, check) and waits at step 7 for staff. 2 Approve and tell: one press, "Approve and tell everyone", approves the rows, sends each patient's voice note (`POST /notify`) and tells each receiving clinic and the hospital who is coming (`POST /packet`). Every patient and clinic is on by default; staff switch off a patient or a whole clinic. 3 Everyone told: step 8 and a done board fill in from simulated replies, with a "Needs you now" list, soonest first, and "Print the list".
* What patients and clinics receive: a patient opens as "What {first name} gets": the message as one text bubble in their language (a tab for English too), when it went out, the reply (Told, Said yes, No answer) and Play voice note. A receiving clinic or the hospital, in "Where they go" or on the done board, opens as "What {clinic} gets": To, From (the home clinic and its callback), "N patients arriving", one row per patient (name, day and time, ride, hepatitis B test date, language), "Reply YES to confirm these slots." and its status. Both read the plan rows and clinic sheets; one panel view that Back or Esc closes.
* Every send and reply is simulated. Nothing leaves Lumen.
* Plan actions: `early_session`, `transfer`, `hospital` (needs a phone call), `notify_only`. Row statuses: `draft`, `approved`, `confirmed`, `declined`, `no_answer`.
* Bedrock model: Qwen2.5-7B-Instruct, imported with Custom Model Import in us-east-2, because the account's foundation-model quota is 0. The Lambda env `AI_STEPS=parse,check,intent` turns on notice parsing, plan-check sentences and re-plan reading. Message writing and the re-plan tool loop are off because the imported model is too slow for them, so messages come from templates (en, es, zh, vi). The first call after a quiet period can take about 2 minutes: warm the model before a demo. The API reports the source of each AI step (`parse_source`, `ai_sources`). The UI never shows it: no source, model, fallback, rules or Lambda labels anywhere (user decision, Oct 24).
* Polly standard voices: English, Spanish, Chinese. A Vietnamese patient's voice note plays in English ("Voice in English"); the message itself is in Vietnamese.
* All patients are synthetic. Patient names never go to Bedrock.
* The PG&E notice is simulated, and the feeders (distribution circuits) and their de-energized state are illustrative; both must be labeled as such. Real distribution circuit data is not public.
* Transmission lines and substations come from OpenStreetMap.

## Brand Commitments

* Name: Lumen.
* Voice: plain, calm, specific. Name the action and the count. Demo rules carry the label "Demo assumptions, not clinical guidance".
* Type: Atkinson Hyperlegible Next and Mono (chosen for legibility). Colors: paper #FBFCFB, ink #13201C, amber #E39A1E only for the primary action, red #C2362F power off, blue #2457C5 routes, green #23784A clinics.

## Evidence on Hand

* `data/seed/clinics.json`: 6 dialysis clinics and Mercy Hospital of Folsom, from CMS facility data, with real coordinates.
* `data/seed/patients.json`: 40 synthetic patients with home coordinates.
* `data/seed/outage_area.geojson`: the illustrative shutoff area.
* `data/seed/notice.txt`: the fictional PSPS notice `PSPS-DEMO-01`.
* `data/seed/santaclara/`: 24 in-center dialysis clinics from CMS data (SHC Evergreen `C11`, the home clinic, SHC Silver Creek `C12` and SHC Santa Teresa `C17` close; the other 21 can receive) and Regional Medical Center (`H11`); 96 synthetic patients (`P101` to `P196`, 32 per closed clinic, fictional callbacks 555-0101 to 555-0196); a simulated shutoff zone over Evergreen, Silver Creek, Santa Teresa and the east foothills; notice `PSPS-DEMO-SC-01`. The plan: 17 come in early, 75 move to 7 clinics, 4 need a phone call.
* Absent, never to fabricate: real PG&E circuits, real patients, outcome metrics, customer quotes, adoption numbers.

## Product Principles

1. Home first. Open on the administrator's own facility, then widen.
2. One decision. Lumen does the work; staff make one approval, "Approve and tell everyone", with an off switch for any patient or clinic. Nothing is sent before it.
3. Show the work. Run demo plays the response as one story on the map: notice, shutoff area, the clinics losing power, the nearest-first search, then routes traced on the roads. Every step stays on screen with its result, during and after the run.
4. Honest labels. The simulated notice, sends and replies, the illustrative grid and synthetic patients are labeled where they appear. No source or model labels on screen, and never claim AI that did not run.
5. Calm under pressure. Few controls, few marks on the map, plain words ("slots", "needs a phone call", "told"), clear counts, no alarm styling beyond the facts.

## Accessibility & Inclusion

WCAG 2.2 AA contrast, full keyboard use of the map and the plan, visible focus, and `prefers-reduced-motion` support. Patients speak English, Spanish, Chinese and Vietnamese; the plan shows each patient's language.
