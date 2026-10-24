# Lumen

**Lumen helps people who depend on electricity get through planned power shutoffs. The demo plans the patients of three dialysis clinics through a PG&E Public Safety Power Shutoff.**

Spark Hill Hackathon 2026 · AWS track

## Why it matters

Dialysis, home oxygen, ventilators, medicine that must stay cold. For people who depend on power, a shutoff is a medical emergency. People on dialysis cannot skip a treatment: when a shutoff closes their clinic, staff must find each patient another slot before the power goes off.

* After Hurricane Sandy, patients who got dialysis early had **28% lower odds of dying** within 30 days.
* **92% of hospitals** said dialysis patients from other clinics arrived without their records.

<sub>Source: [ASPR TRACIE, Dialysis lessons learned from Hurricane Sandy](https://files.asprtracie.hhs.gov/documents/aspr-tracie-ta-dialysis-hurricane-sandy-lessons-learned-07015-508.pdf).</sub>

## How it works

<img src="docs/how-it-works.svg" width="100%" alt="How Lumen works, in five steps before the power goes off: Shutoff notice arrives. Lumen finds who is at risk. A plan for each person. You approve once. Everyone is told.">

Lumen reads, finds and plans. A person approves. Then Lumen tells everyone and shows who still needs a phone call.

## Try it

**[main.d1eh2uukook6ji.amplifyapp.com](https://main.d1eh2uukook6ji.amplifyapp.com)**

1. Press **Try the live demo**. The console opens on Santa Clara County. A simulated PG&E shutoff closes three dialysis clinics in San Jose, and 96 of their patients have a treatment while the power is off.
2. Press **Run demo**. On the map you see the notice, the shutoff area, the clinics losing power, the search for open slots and the routes. Every step stays on screen with its result. Then the run waits for you: 92 patients have a slot, and 4 need a phone call.
3. Press **Review and approve**, then **Approve and tell everyone**. Replies come in, and the done board shows who still needs a call.
4. Pick a clinic in **Where they go**, or a patient, to see what they receive.

The live run asks for a demo key. Ask the team for one.

## How it is built on AWS

**AWS Lambda.** One Python function behind a function URL is the whole API. It reads the notice, finds who is affected, ranks patients, finds open slots, checks the plan, and records every approval and send. Every request needs the demo key.

**Amazon S3.** Holds the seed data and every plan version, so each change is a new version you can trace. Each browser tab works in its own session, so one viewer's run never touches another's.

**Amazon Bedrock.** Runs Qwen2.5-7B-Instruct, which we brought in with Custom Model Import. It reads the PG&E notice, explains the plan check in plain sentences, and turns a typed change ("SHC South San Jose can only take 10 more") into edits that code checks before it applies them. When the model is slow or fails, code does the step.

**Amazon Polly.** Reads each patient's message aloud as a voice note in English, Spanish or Chinese.

**Amazon Location Service.** Draws the map and traces real road routes from each closed clinic to the clinics that take its patients, in the browser.

**AWS Amplify.** Hosts the web app: static files, no build step.

## What the AI does and does not do

**The model reads.** It reads the notice, explains the plan check, points out patients who may need a call, and reads re-plan requests.

**Rules decide.** Code ranks patients, gives each one the nearest clinic with a free slot at their time, and finds the problems in the plan. Code keeps a model flag only when the patient's facts match it. The model cannot remove a problem or make it less serious.

**People approve.** Nothing goes out until staff approve. Patient names never reach the model: code swaps them for IDs first.

## Honest data

* **Patients are synthetic.** Names, homes, phone numbers and health details are made up.
* **The PG&E notice is simulated,** and so are the voice notes, clinic sheets and replies. Nothing leaves Lumen.
* **Dialysis clinics are real.** Names, addresses and stations come from public CMS data. Open slots are simulated.
* The shutoff area is a drawing, not a PG&E map. It covers Evergreen, Silver Creek, Santa Teresa and the east foothills of San Jose. PG&E cut power in parts of this area in October 2019.
* Power lines and substations come from OpenStreetMap. Feeders are illustrative.
* The rules are demo assumptions, not clinical guidance.

## Run it locally

```bash
python3 -m http.server 5173 -d frontend/prototype
```

Open http://localhost:5173/. Use `localhost`, not `127.0.0.1`: the map key works only there. Add the demo key from the team in the console's **Demo** menu.

Tests and the seed check:

```bash
pip install -r backend/requirements-dev.txt
python scripts/validate_seed.py
cd backend && python -m pytest -q
```

The API is in [contracts/api.md](contracts/api.md). Deploy and debugging steps are in [docs/operations.md](docs/operations.md).

## Team

Vi Huynh · Zayd Bashir · Asthra Meadipudi · Saieesha Marta
