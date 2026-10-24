# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static pages in `frontend/prototype/` (`landing.html`, then `console.html`) with no build step, deployed to AWS Amplify by manual upload. Libraries come from CDNs. The API is one Lambda function URL (`contracts/api.md`).

## Users

The primary user is a dialysis clinic administrator: Rosa, the manager of DaVita Cameron Park Dialysis (the home clinic, `C01`; in Santa Clara County the home clinic is SHC Evergreen, `C11`). She is 61, runs facility operations, is not a clinician at the chair or a technical person, and works under time pressure. The team calls this audience "hospital administrators".

Their situation: PG&E sends a Public Safety Power Shutoff (PSPS) warning about 48 hours before it cuts power. Before the shutoff starts, the administrator must find out which patients miss a treatment, find each one another chair, and tell every patient and every receiving clinic.

Secondary audience: hackathon judges (Spark Hill Hackathon 2026, AWS track) who watch a recorded or live demo.

## Product Purpose

Lumen turns a PSPS notice into a patient-by-patient treatment plan, gets one approval, and tells everyone. It reads the notice, finds the closed clinic and the affected sessions, ranks patients by urgency, gives each patient the nearest clinic with a free chair at their time (an early session at home, a transfer, or a phone call from staff when no chair fits), writes patient messages and checks the plan. One press then sends each patient a voice note in their language and tells each receiving clinic and the hospital who is coming, with each patient's sheet. These sends and the replies are simulated.

Success: before the shutoff, every affected patient has a confirmed chair or a phone call from staff, everyone is told, and the administrator sees at a glance who still needs a call.

## Positioning

AI reads and explains, rules decide, people approve. A model on Amazon Bedrock reads the notice, rewords the plan check into plain sentences, and reads plain-language re-plan instructions into changes that code checks and applies. Deterministic code ranks patients, picks chairs, checks capacity and decides who gets a voice note. No message goes out without staff approval. The screen shows no source or model labels, and never claims AI that did not run.

## Operating Context

* The administrator works from the home facility on a desktop or laptop, during office hours, under time pressure.
* The map shows the home facility and the shutoff area first. Power lines show only in the run's "loses power" scene.
* The demo runs on the deployed Amplify URL with a demo key, recorded at 1920 x 1080, and also on a laptop for judges.
* Regions: El Dorado County (Cameron Park, Folsom, Rancho Cordova) and Santa Clara County (East San Jose). Both run on the live API (`?region=eldorado|santaclara`, default `eldorado`).
* Map tiles: Amazon Location Service (Monochrome style, us-east-2) with a referrer-restricted API key. The page falls back to OpenFreeMap tiles if that style fails to load.

## Capabilities and Constraints

* API routes: `GET /state`, `POST /alert`, `/plan`, `/check`, `/approve`, `/replan`, `/notify`, `/packet`, `/voice`, `/speak`, `/reset`. Header `X-Demo-Key` on every request. Optional `?session=` (each browser tab has its own plans) and `?region=`.
* The flow has three stages. 1 Plan made: Run demo plays the run (notice, shutoff area, the clinic loses power, nearest-first search, routes traced, messages, check); then the rail folds to three stages and the eight steps hide behind "How this plan was made". 2 Approve and tell: one press, "Approve and tell everyone", approves the rows, sends each patient's voice note (`POST /notify`) and tells each receiving clinic and the hospital who is coming (`POST /packet`). Every patient and clinic is on by default; staff switch off a patient or a whole clinic. 3 Everyone told: a done board fills in from simulated replies, with a "Needs you now" list, soonest first, and "Print the list".
* Every send and reply is simulated. Nothing leaves Lumen.
* Plan actions: `early_session`, `transfer`, `hospital` (staff call), `notify_only`. Row statuses: `draft`, `approved`, `confirmed`, `declined`, `no_answer`.
* Bedrock model: Qwen2.5-7B-Instruct, imported with Custom Model Import in us-east-2, because the account's foundation-model quota is 0. The Lambda env `AI_STEPS=parse,check,intent` turns on notice parsing, plan-check sentences and re-plan reading. Message writing and the re-plan tool loop are off because the imported model is too slow for them, so messages come from templates (en, es, zh, vi). The first call after a quiet period can take about 2 minutes: warm the model before a demo. The API reports the source of each AI step (`parse_source`, `ai_sources`). The UI never shows it: no source, model, fallback, rules or Lambda labels anywhere (user decision, Oct 24).
* Polly standard voices: English, Spanish, Chinese. A Vietnamese row has a message but no audio, and the screen says so.
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
* `data/seed/santaclara/`: SHC Evergreen, 6 receiving clinics from CMS data and Regional Medical Center, 40 synthetic patients (`P101` to `P140`), a simulated shutoff zone and notice `PSPS-DEMO-SC-01`.
* Absent, never to fabricate: real PG&E circuits, real patients, outcome metrics, customer quotes, adoption numbers.

## Product Principles

1. Home first. Open on the administrator's own facility, then widen.
2. One decision. Lumen does the work; staff make one approval, "Approve and tell everyone", with an off switch for any patient or clinic. Nothing is sent before it.
3. Show the work, then fold it away. Run demo plays the response as one story on the map: notice, shutoff area, the clinic losing power, the nearest-first search, then routes traced on the roads. After the run, three stages stay and the steps hide behind "How this plan was made".
4. Honest labels. The simulated notice, sends and replies, the illustrative grid and synthetic patients are labeled where they appear. No source or model labels on screen, and never claim AI that did not run.
5. Calm under pressure. Few controls, few marks on the map, plain words ("chairs", "needs a phone call", "told"), clear counts, no alarm styling beyond the facts.

## Accessibility & Inclusion

WCAG 2.2 AA contrast, full keyboard use of the map and the plan, visible focus, and `prefers-reduced-motion` support. Patients speak English, Spanish, Chinese and Vietnamese; the plan shows each patient's language.
