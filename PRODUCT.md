# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static single-page app in `frontend/prototype/` with no build step, deployed to AWS Amplify by manual upload. Libraries come from CDNs. The API is one Lambda function URL (`contracts/api.md`).

## Users

The primary user is a dialysis clinic administrator: Rosa, the manager of DaVita Cameron Park Dialysis (the home clinic, `C01`). The team calls this audience "hospital administrators": people who run facility operations, not clinicians at the chair.

Their situation: PG&E sends a Public Safety Power Shutoff (PSPS) warning about 48 hours before it cuts power. The administrator must find out which of their facilities lose power, which patients miss a treatment, and where each patient dialyzes instead, before the shutoff starts.

Secondary audience: hackathon judges (Spark Hill Hackathon 2026, AWS track) who watch a recorded or live demo.

## Product Purpose

Lumen turns a PSPS notice into a patient-by-patient treatment plan that staff approve. It reads the notice, finds the closed clinics and the affected sessions, ranks patients by urgency, assigns open chairs (an early session at home, a transfer, or a hospital staff call), writes patient messages, and makes voice notes.

Success: every affected patient has a confirmed chair or a staff call before the shutoff, and the administrator can see and change every decision.

## Positioning

AI reads and explains, rules decide, people approve. A model on Amazon Bedrock reads the notice, rewords the plan check into plain sentences, and reads plain-language re-plan instructions into changes that code checks and applies. Deterministic code ranks patients, picks chairs, checks capacity and decides who gets a voice note. No message goes out without staff approval. The screen shows no source or model labels, and never claims AI that did not run.

## Operating Context

* The administrator works from the home facility on a desktop or laptop, during office hours, under time pressure.
* The map must show the home facility, its power grid, and how the shutoff affects it, first.
* The demo runs on the deployed Amplify URL with a demo key, recorded at 1920 x 1080, and also on a laptop for judges.
* Region: El Dorado County (Cameron Park, Folsom, Rancho Cordova) is the live API story. A scripted Santa Clara County tour is kept as a second region.
* Map tiles: Amazon Location Service (Monochrome style, us-east-2) with a referrer-restricted API key. The page falls back to OpenFreeMap tiles if that style fails to load.

## Capabilities and Constraints

* API routes: `GET /state`, `POST /alert`, `/plan`, `/approve`, `/voice`, `/replan`, `/reset`. Header `X-Demo-Key` on every request.
* Plan actions: `early_session`, `transfer`, `hospital` (staff call), `notify_only`. Row statuses: `draft`, `approved`, `confirmed`, `declined`, `no_answer`.
* Bedrock model: Qwen2.5-7B-Instruct, imported with Custom Model Import in us-east-2, because the account's foundation-model quota is 0. The Lambda env `AI_STEPS=parse,check,intent` turns on notice parsing, plan-check sentences and re-plan reading. Message writing and the re-plan tool loop are off because the imported model is too slow for them, so messages come from templates (en, es, zh). The first call after a quiet period can take about 2 minutes: warm the model before a demo. The API reports the source of each AI step (`parse_source`, `ai_sources`). The UI never shows it: no source, model, fallback, rules or Lambda labels anywhere (user decision, Oct 24).
* Polly standard voices: English, Spanish, Chinese.
* All patients are synthetic. Patient names never go to Bedrock.
* The PG&E notice is simulated, and the feeders (distribution circuits) and their de-energized state are illustrative; both must be labeled as such. Real distribution circuit data is not public.
* Transmission lines and substations come from OpenStreetMap.

## Brand Commitments

* Name: Lumen.
* Voice: plain, calm, specific. Name the action and the count. Demo rules carry the label "Demo assumptions, not clinical guidance".
* Incumbent type family: Atkinson Hyperlegible (chosen for legibility). Not yet confirmed as binding.

## Evidence on Hand

* `data/seed/clinics.json`: 6 dialysis clinics and Mercy Hospital of Folsom, from CMS facility data, with real coordinates.
* `data/seed/patients.json`: 40 synthetic patients with home coordinates.
* `data/seed/outage_area.geojson`: the illustrative shutoff area.
* `data/seed/notice.txt`: the fictional PSPS notice `PSPS-DEMO-01`.
* Santa Clara tour data (in the prototype): 31 CMS centers, 642 stations, 420 synthetic patients.
* Absent, never to fabricate: real PG&E circuits, real patients, outcome metrics, customer quotes, adoption numbers.

## Product Principles

1. Home first. Open on the administrator's own facility and its grid, then widen.
2. Show the work in plain words. Each step says what it did, and Run demo plays the response as one story on the map: notice, shutoff area, the clinic losing power, then routes traced on the roads to clinics with free chairs.
3. People approve. The plan is a draft until staff approve it; nothing implies automatic sending.
4. Honest labels. The illustrative grid, the simulated notice and synthetic patients are labeled where they appear. Never claim AI that did not run.
5. Calm under pressure. Few controls, clear counts, no alarm styling beyond the facts.

## Accessibility & Inclusion

WCAG 2.2 AA contrast, full keyboard use of the map and the plan, visible focus, and `prefers-reduced-motion` support. Patients speak English, Spanish and Chinese; the plan shows each patient's language.
